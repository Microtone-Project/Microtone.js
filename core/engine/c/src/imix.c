/* Per-instrument mixing chains — port of imix.js (the equipment, the chain,
 * the buses and the routing) and imix-section.js (the `IMix` section's
 * decoder). TAUD_ENGINE_SPEC.md §12.4, TAUD_FILE_FORMAT.md §9.15.
 *
 * An instrument whose record names an IMix block (byte 255) does not mix its
 * voices straight into the master: they sum into the instrument's own bus —
 * or, in bus mode, into one bus every instrument on the block shares — that
 * bus runs the block's chain, and the result joins the master, scaled by the
 * song's global gain, in ascending slot order. A block that is off, or holds
 * nothing that is not bypassed, makes no bus at all: the plain path, to the
 * bit.
 *
 *   order 0: itrm → expd → equ1 → deq1 → tsh1 → comp → equ2 → deq2 → unis → satu → dlay → verb → limi → mxtl
 *   order 1: itrm → expd → equ1 → deq1 → tsh1 → comp → equ2 → deq2 → unis → satu → verb → dlay → limi → mxtl
 *
 * Everything that accumulates (an LFO's phase, a pitch shifter's sweep, a tape
 * delay's glide, its wow and flutter) is integer arithmetic on 16.16
 * quantities, held here in int64_t where the JS holds exact binary64
 * integers; filters and envelopes are binary64 as everywhere else. A chain's
 * output does not depend on how its bus is cut into spans: every counter,
 * phase and the idle rule are per sample. The Mixing tab's meter tap and the
 * display responses are the editor's and are not ported. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

#define PI 3.141592653589793
#define SQRT1_2 0.7071067811865476
#define LN2 0.6931471805599453
#define FX16 65536
#define TWO32 4294967296.0
#define TWO32I ((int64_t)1 << 32)

#define IMX_DELAY_MAX_SEC 4
#define IMX_PREDELAY_MAX_SEC 0.5
#define IMX_CONTROL_PERIOD 16
#define IMX_IDLE_LEVEL (1.0 / 16777216.0)    /* 2^-24 */
#define IMX_IDLE_MARGIN_SEC 0.05
#define IMX_DC_HZ 3.0
#define IMX_DC_K 6.3
#define IMX_TSH_WINDOW_SEC 0.025
#define IMX_TSH_SMOOTH_MS 1
#define IMX_EXPD_WINDOW_SEC 0.025

/* Equaliser band shapes. */
#define EQ_HIGH_PASS 0
#define EQ_LOW_SHELF_ 1
#define EQ_BELL 2
#define EQ_HIGH_SHELF_ 3
#define EQ_LOW_PASS 4
#define EQ_NOTCH 5
#define EQ_SHAPES 6
#define EQ_SLOPES 4

#define SAT_TAPE 0
#define SAT_SOFT 1
#define SAT_HARD 2
#define SAT_TUBE 3
#define SAT_FOLD 4
#define SAT_CURVES 5

#define LFO_SINE 0
#define LFO_TRIANGLE 1
#define LFO_SQUARE 2
#define LFO_SAW_UP 3
#define LFO_SAW_DOWN 4
#define LFO_RANDOM 5
#define LFO_WAVES 6

#define DEQ_LOW_SHELF_BAND 0
#define DEQ_HIGH_SHELF_BAND 1

static const char FOURCC[IMX_KINDS][5] = {
    "itrm", "expd", "equ1", "deq1", "tsh1", "comp", "equ2", "deq2", "unis", "satu", "dlay", "verb", "limi", "mxtl"
};

static const int PIPELINES[2][IMX_KINDS] = {
    { IMX_ITRM, IMX_EXPD, IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2,
      IMX_UNIS, IMX_SATU, IMX_DLAY, IMX_VERB, IMX_LIMI, IMX_MXTL },
    { IMX_ITRM, IMX_EXPD, IMX_EQU1, IMX_DEQ1, IMX_TSH1, IMX_COMP, IMX_EQU2, IMX_DEQ2,
      IMX_UNIS, IMX_SATU, IMX_VERB, IMX_DLAY, IMX_LIMI, IMX_MXTL },
};

/* Equipment whose wet/dry byte means something; everything else must carry 0. */
static bool wet_applicable(int k)
{
    return k == IMX_EXPD || k == IMX_TSH1 || k == IMX_COMP || k == IMX_UNIS || k == IMX_SATU || k == IMX_DLAY
        || k == IMX_VERB;
}

static bool is_cut_shape(int shape) { return shape == EQ_HIGH_PASS || shape == EQ_LOW_PASS; }

/* ── the section's decoder (imix-section.js) ─────────────────────────────── */

static uint32_t rd_u32(const uint8_t *b)
{
    return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}

static double rd_f32(const uint8_t *b)
{
    union { uint32_t u; float f; } c;
    c.u = rd_u32(b);
    return c.f;
}

static int fourcc_kind(const uint8_t *b)
{
    int k;
    for (k = 0; k < IMX_KINDS; k++) if (memcmp(b, FOURCC[k], 4) == 0) return k;
    return -1;
}

/* imxClamp: a binary32 inside the range, or the fallback when not finite. */
static float clampf(double v, double lo, double hi, double fallback)
{
    if (!isfinite(v)) return (float)fallback;
    return (float)(v < lo ? lo : v > hi ? hi : v);
}

/* imxClampFx: the 16.16 fields are U32 in the file — integers, clamped. */
static uint32_t clampfx(uint32_t v, uint32_t lo, uint32_t hi) { return v < lo ? lo : v > hi ? hi : v; }

static bool read_lfo(const uint8_t *b, TaudImxLfoParams *l)
{
    if (b[0] >= LFO_WAVES) return false;
    l->wave = b[0];
    l->retrigger = (b[1] & 1) != 0;
    l->sync = (b[1] & 2) != 0;
    /* normLfo: the rate in 16.16 Hz (0.01…40) or quarter ticks (1…4096). */
    l->rate = l->sync ? clampfx(rd_u32(b + 4), FX16, 4096u * FX16) : clampfx(rd_u32(b + 4), 655, 40u * FX16);
    l->depth = clampf(rd_f32(b + 8), 0, 1, 0);
    return true;
}

/* Where the crossovers of an n-band split start: log-spaced over 80 Hz…8 kHz. */
static void default_crossovers(int n, float *out)
{
    int i;
    for (i = 1; i < n; i++) out[i - 1] = (float)(80 * js_pow(100, (double)(i - 1) / imax(1, n - 2)));
    if (n == 2) out[0] = (float)400;
}

static const double DEQ_DEFAULT_FREQS[IMX_DEQ_BANDS] = { 100, 8000, 250, 1000, 3000, 6000 };

/* Decode one known, version-0 payload, normalised (decodeEquipment +
 * normaliseEquipment); false on a contradiction. */
static bool decode_equipment(int k, const uint8_t *p, size_t len, TaudImxEquipment *e)
{
    static const size_t FIXED[IMX_KINDS] = { 8, 48, 0, 296, 0, 0, 0, 296, 44, 24, 32, 24, 20, 16 };
    int i;
    if (FIXED[k] != 0 && len != FIXED[k]) return false;
    if (!wet_applicable(k) && p[1] != 0) return false;
    memset(e, 0, sizeof *e);
    e->present = true;
    e->bypass = (p[0] & 0x80) != 0;
    e->dry = wet_applicable(k) ? p[1] : 0;
    switch (k) {
    case IMX_ITRM:
        e->u.trim.gainDb = clampf(rd_f32(p + 4), -24, 24, 0);
        return true;
    case IMX_EXPD: {
        double floorRaw = rd_f32(p + 12);
        if (p[5] > 1) return false;
        /* A floor above the threshold says the sound is shut where it should pass. */
        if (floorRaw > rd_f32(p + 8)) return false;
        e->u.expd.keyFilter = (p[4] & 1) != 0;
        e->u.expd.detector = p[5] == COMP_RMS ? COMP_RMS : COMP_PEAK;
        e->u.expd.threshDb = clampf(rd_f32(p + 8), -80, 0, -50);
        /* No floor is −∞ (a pure expander); one above the threshold, once
         * clamped, is brought down to it. */
        if (isnan(floorRaw) || floorRaw == -INFINITY) e->u.expd.floorDb = -INFINITY;
        else {
            float f = clampf(floorRaw, -80, 0, e->u.expd.threshDb);
            e->u.expd.floorDb = f < e->u.expd.threshDb ? f : e->u.expd.threshDb;
        }
        e->u.expd.ratio = clampf(rd_f32(p + 16), 1, 20, 2);
        e->u.expd.rangeDb = clampf(rd_f32(p + 20), 0, 80, 24);
        e->u.expd.attackMs = clampf(rd_f32(p + 24), 0.1, 300, 1);
        e->u.expd.holdMs = clampf(rd_f32(p + 28), 0, 2000, 20);
        e->u.expd.releaseMs = clampf(rd_f32(p + 32), 5, 3000, 150);
        e->u.expd.hysteresisDb = clampf(rd_f32(p + 36), 0, 12, 4);
        e->u.expd.keyLowCut = clampf(rd_f32(p + 40), 20, 2000, 80);
        e->u.expd.keyHighCut = clampf(rd_f32(p + 44), 500, 20000, 12000);
        return true;
    }
    case IMX_TSH1: {
        int n;
        bool ok = true;
        double prev = 0;
        if (len < 8) return false;
        n = p[4];
        if (n < 1 || n > IMX_TSH_MAX_BANDS) return false;
        if (len != (size_t)(8 + 4 * (n - 1) + 24 * n)) return false;
        for (i = 0; i < n - 1; i++) {
            double x = rd_f32(p + 8 + 4 * i);
            if (i > 0 && !(x > prev)) return false;
            prev = x;
        }
        e->u.tsh.n = n;
        for (i = 0; i < n; i++) {
            const uint8_t *o = p + 8 + 4 * (n - 1) + i * 24;
            TaudImxTshBand *b = &e->u.tsh.b[i];
            b->on = (o[0] & 1) != 0;
            b->attackDb = clampf(rd_f32(o + 4), -24, 24, 0);
            b->sustainDb = clampf(rd_f32(o + 8), -24, 24, 0);
            b->attackMs = clampf(rd_f32(o + 12), 1, 300, 20);
            b->releaseMs = clampf(rd_f32(o + 16), 10, 3000, 250);
            b->outDb = clampf(rd_f32(o + 20), -24, 24, 0);
        }
        /* n − 1 crossovers, strictly ascending once clamped, or re-spread. */
        for (i = 0; i < n - 1; i++) {
            e->u.tsh.xover[i] = clampf(rd_f32(p + 8 + 4 * i), 20, 20000, 1000);
            if (i > 0 && !(e->u.tsh.xover[i] > e->u.tsh.xover[i - 1])) ok = false;
        }
        if (!ok) default_crossovers(n, e->u.tsh.xover);
        return true;
    }
    case IMX_EQU1:
    case IMX_EQU2: {
        int n;
        if (len < 8) return false;
        n = p[4];
        if (n > IMX_EQ_MAX_BANDS) return false;
        if (len != (size_t)(8 + n * 16)) return false;
        e->u.eq.n = n;
        for (i = 0; i < n; i++) {
            const uint8_t *o = p + 8 + i * 16;
            TaudImxEqBand *b = &e->u.eq.b[i];
            int shape = o[1];
            if (shape >= EQ_SHAPES || o[2] >= EQ_SLOPES) return false;
            if (!is_cut_shape(shape) && o[2] != 0) return false;
            b->on = (o[0] & 1) != 0;
            b->shape = shape;
            b->slope = is_cut_shape(shape) ? o[2] : 0;
            b->freq = clampf(rd_f32(o + 4), 20, 20000, 1000);
            b->gainDb = clampf(rd_f32(o + 8), -24, 24, 0);
            b->q = clampf(rd_f32(o + 12), 0.1, 18, SQRT1_2);
        }
        return true;
    }
    case IMX_COMP: {
        int n;
        bool ok = true;
        double prev = 0;
        if (len < 8) return false;
        n = p[4];
        if (n < 1 || n > IMX_COMP_MAX_BANDS) return false;
        if (p[5] > 1) return false;
        if (len != (size_t)(8 + 4 * (n - 1) + 28 * n)) return false;
        for (i = 0; i < n - 1; i++) {
            double x = rd_f32(p + 8 + 4 * i);
            if (i > 0 && !(x > prev)) return false;
            prev = x;
        }
        e->u.comp.detector = p[5] == COMP_RMS ? COMP_RMS : COMP_PEAK;
        e->u.comp.n = n;
        for (i = 0; i < n; i++) {
            const uint8_t *o = p + 8 + 4 * (n - 1) + i * 28;
            TaudImxCompBand *b = &e->u.comp.b[i];
            b->on = (o[0] & 1) != 0;
            b->threshDb = clampf(rd_f32(o + 4), -60, 0, -18);
            b->ratio = clampf(rd_f32(o + 8), 1, 20, 3);
            b->attackMs = clampf(rd_f32(o + 12), 0.1, 300, 10);
            b->releaseMs = clampf(rd_f32(o + 16), 5, 3000, 120);
            b->kneeDb = clampf(rd_f32(o + 20), 0, 24, 6);
            b->makeupDb = clampf(rd_f32(o + 24), -12, 24, 0);
        }
        /* n − 1 crossovers, strictly ascending once clamped, or re-spread. */
        for (i = 0; i < n - 1; i++) {
            e->u.comp.xover[i] = clampf(rd_f32(p + 8 + 4 * i), 20, 20000, 1000);
            if (i > 0 && !(e->u.comp.xover[i] > e->u.comp.xover[i - 1])) ok = false;
        }
        if (!ok) default_crossovers(n, e->u.comp.xover);
        return true;
    }
    case IMX_DEQ1:
    case IMX_DEQ2:
        for (i = 0; i < IMX_DEQ_BANDS; i++) {
            const uint8_t *o = p + 8 + i * 48;
            TaudImxDeqBand *b = &e->u.deq.b[i];
            double rf = rd_f32(o + 4), rq = rd_f32(o + 8), sf = rd_f32(o + 16), sq = rd_f32(o + 20);
            double dq = i < 2 ? SQRT1_2 : 1;
            bool unlinked = (o[0] & 2) != 0;
            /* A linked band senses where it acts, and its file says so. */
            if (!unlinked && !(sf == rf && sq == rq)) return false;
            b->on = (o[0] & 1) != 0;
            b->unlinked = unlinked;
            b->boost = (o[0] & 4) != 0;
            b->freq = clampf(rf, 20, 20000, DEQ_DEFAULT_FREQS[i]);
            b->q = clampf(rq, 0.1, 18, dq);
            b->gainDb = clampf(rd_f32(o + 12), -24, 24, 0);
            b->senseFreq = unlinked ? clampf(sf, 20, 20000, b->freq) : b->freq;
            b->senseQ = unlinked ? clampf(sq, 0.1, 18, b->q) : b->q;
            b->threshDb = clampf(rd_f32(o + 24), -60, 0, -24);
            b->ratio = clampf(rd_f32(o + 28), 1, 20, 3);
            b->attackMs = clampf(rd_f32(o + 32), 0.1, 300, 5);
            b->releaseMs = clampf(rd_f32(o + 36), 5, 3000, 100);
            b->rangeDb = clampf(rd_f32(o + 40), 0, 24, 6);
            b->actorDb = clampf(rd_f32(o + 44), -24, 24, 0);
        }
        return true;
    case IMX_SATU:
        if (p[4] >= SAT_CURVES) return false;
        e->u.sat.curve = p[4];
        e->u.sat.driveDb = clampf(rd_f32(p + 8), 0, 36, 6);
        e->u.sat.inDb = clampf(rd_f32(p + 12), -24, 24, 0);
        e->u.sat.outDb = clampf(rd_f32(p + 16), -24, 24, 0);
        e->u.sat.bias = clampf(rd_f32(p + 20), -1, 1, 0);
        return true;
    case IMX_UNIS:
        if (p[4] < 2 || p[4] > IMX_UNIS_MAX_VOICES) return false;
        e->u.unis.voices = p[4];
        e->u.unis.detune = clampf(rd_f32(p + 8), 0, 100, 15);
        e->u.unis.width = clampf(rd_f32(p + 12), 0, 1, 0.8);
        e->u.unis.spacing = clampf(rd_f32(p + 16), 0, 1, 0);
        return read_lfo(p + 20, &e->u.unis.detuneLfo) && read_lfo(p + 32, &e->u.unis.widthLfo);
    case IMX_VERB:
        e->u.verb.size = clampf(rd_f32(p + 8), 0, 1, 0.5);
        e->u.verb.decay = clampf(rd_f32(p + 12), 0.1, 30, 1.8);
        e->u.verb.damping = clampf(rd_f32(p + 16), 1000, 20000, 8000);
        e->u.verb.preDelay = clampfx(rd_u32(p + 20), 0, (uint32_t)(IMX_PREDELAY_MAX_SEC * FX16));
        return true;
    case IMX_DLAY:
        e->u.dlay.sync = (p[4] & 1) != 0;
        e->u.dlay.pingPong = (p[4] & 2) != 0;
        e->u.dlay.pingRight = (p[4] & 6) == 6;   /* right first: R-L-R-L */
        e->u.dlay.time = e->u.dlay.sync ? clampfx(rd_u32(p + 8), FX16 / 4, 1024u * FX16)
                                        : clampfx(rd_u32(p + 8), 66, IMX_DELAY_MAX_SEC * FX16);
        e->u.dlay.feedback = clampf(rd_f32(p + 12), 0, 1.2, 0.35);
        e->u.dlay.highCut = clampf(rd_f32(p + 16), 500, 20000, 6000);
        e->u.dlay.lowCut = clampf(rd_f32(p + 20), 20, 2000, 120);
        e->u.dlay.wow = clampf(rd_f32(p + 24), 0, 1, 0.2);
        e->u.dlay.driveDb = clampf(rd_f32(p + 28), 0, 24, 3);
        return true;
    case IMX_LIMI:
        e->u.lim.truePeak = (p[4] & 1) != 0;
        e->u.lim.ceilingDb = clampf(rd_f32(p + 8), -24, 0, -1);
        e->u.lim.releaseMs = clampf(rd_f32(p + 12), 1, 1000, 60);
        e->u.lim.gainDb = clampf(rd_f32(p + 16), -12, 24, 0);
        return true;
    default: /* IMX_MXTL */
        e->u.mx.swap = (p[4] & 1) != 0;
        e->u.mx.invL = (p[4] & 2) != 0;
        e->u.mx.invR = (p[4] & 4) != 0;
        e->u.mx.removeDc = (p[4] & 8) != 0;
        e->u.mx.gainDb = clampf(rd_f32(p + 8), -24, 24, 0);
        e->u.mx.width = clampf(rd_f32(p + 12), 0, 2, 1);
        return true;
    }
}

/* Decode the block at `o` (decodeBlock). Returns the offset past it, or 0
 * when it is invalid. */
static size_t decode_block(const uint8_t *b, size_t len, size_t o, TaudImixBlock *blk)
{
    const uint8_t *list, *seen[255];
    size_t p;
    int n, status, i, j;
    if (o + 4 > len) return 0;
    if (b[o] == 0) return 0;                    /* id 0 is "no chain" */
    status = b[o + 2];
    if ((status >> 4) > 1) return 0;            /* pipeline order */
    n = b[o + 3];
    p = o + 4;
    if (p + 4 * (size_t)n > len) return 0;
    list = b + p;
    for (i = 0; i < n; i++)                     /* the list names no piece twice */
        for (j = i + 1; j < n; j++)
            if (memcmp(list + 4 * i, list + 4 * j, 4) == 0) return 0;
    p += 4 * (size_t)n;
    memset(blk, 0, sizeof *blk);
    blk->id = b[o];
    blk->enabled = (status & 1) != 0;
    blk->bus = (status & 2) != 0;
    blk->order = status >> 4;
    for (i = 0; i < n; i++) {
        const uint8_t *fc, *payload;
        size_t size;
        int k;
        bool listed = false;
        if (p + 8 > len) return 0;
        fc = b + p;
        size = rd_u32(b + p + 4);
        p += 8;
        if (size > len - p) return 0;
        if (size < 4) return 0;
        payload = b + p;
        p += size;
        for (j = 0; j < i; j++) if (memcmp(seen[j], fc, 4) == 0) return 0;  /* a record twice */
        seen[i] = fc;
        /* The list is a table of contents: every record must be in it (and,
         * n records with none twice, that makes the two the same set). */
        for (j = 0; j < n; j++) if (memcmp(list + 4 * j, fc, 4) == 0) listed = true;
        if (!listed) return 0;
        k = fourcc_kind(fc);
        /* Equipment this reader does not know — an unknown FourCC, or a
         * payload version above 0 — is kept verbatim by the reference and
         * skipped by playback. */
        if (k < 0 || (payload[0] & 0x0f) > 0) continue;
        if (!decode_equipment(k, payload, size, &blk->eq[k])) return 0;
    }
    return p;
}

/* Where the block at `o` ends, from its framing alone, or 0 (skipBlock). */
static size_t skip_block(const uint8_t *b, size_t len, size_t o)
{
    size_t p;
    int n, i;
    if (o + 4 > len) return 0;
    n = b[o + 3];
    p = o + 4 + 4 * (size_t)n;
    for (i = 0; i < n; i++) {
        size_t size;
        if (p + 8 > len) return 0;
        size = rd_u32(b + p + 4);
        if (size > len - p - 8) return 0;
        p += 8 + size;
    }
    return p;
}

/* Whole-section payload → its valid blocks (parseImixSection). A block that
 * contradicts itself is dropped whole, and so is every block of an id two
 * blocks share; one that cannot be delimited ends the walk. Returns the
 * count (*out malloc'd, or NULL), or -1 when out of memory. */
int te_imix_parse_section(const uint8_t *b, size_t len, TaudImixBlock **out)
{
    TaudImixBlock *list = NULL;
    int count = 0, cap = 0, i, j, kept = 0;
    size_t o = 0;
    *out = NULL;
    while (o < len) {
        TaudImixBlock blk;
        size_t next = decode_block(b, len, o, &blk);
        if (next == 0) {
            next = skip_block(b, len, o);
            if (next == 0) break;
            o = next;
            continue;
        }
        o = next;
        if (count == cap) {
            int nc = cap == 0 ? 8 : cap * 2;
            TaudImixBlock *nl = (TaudImixBlock *)realloc(list, sizeof *list * (size_t)nc);
            if (nl == NULL) { free(list); return -1; }
            list = nl;
            cap = nc;
        }
        list[count++] = blk;
    }
    /* An id two decoded blocks share is invalid however many copies there are.
     * (Marked before the list is compacted over itself.) */
    {
        bool shared[256];
        memset(shared, 0, sizeof shared);
        for (i = 0; i < count; i++)
            for (j = i + 1; j < count; j++)
                if (list[j].id == list[i].id) shared[list[i].id] = true;
        for (i = 0; i < count; i++) if (!shared[list[i].id]) list[kept++] = list[i];
    }
    if (kept == 0) { free(list); return 0; }
    *out = list;
    return kept;
}

/* Would a chain built from this block change a sample (imixBlockEngaged)? */
bool te_imix_block_engaged(const TaudImixBlock *b)
{
    int k;
    if (b == NULL || !b->enabled) return false;
    for (k = 0; k < IMX_KINDS; k++) if (b->eq[k].present && !b->eq[k].bypass) return true;
    return false;
}

/* ── the equipment ───────────────────────────────────────────────────────── */
/* Every piece: configure (keeps state), reset, process over a channel-major
 * buffer in place, and its memory (the samples its delays hold). */

typedef struct {
    int nch;
    bool stereo, ambisonic;
    int bpm;
    double dry;
    double *dryBuf;
} ImxCtx;

/* One LFO: a U32 phase, a waveform, and (for S&H) its own random stream. */
typedef struct {
    TaudImxLfoParams p;
    int64_t phase, inc;
    int kSync, kBpm, kFs;
    int64_t kRate;
    double held;
    uint32_t rng;
} ImxLfo;

static void lfo_init(ImxLfo *l)
{
    memset(l, 0, sizeof *l);
    l->p.rate = FX16 / 2;
    l->kSync = -1; l->kRate = -1; l->kBpm = -1; l->kFs = -1;
    l->rng = 0x9e3779b9u;
}

static void lfo_configure(ImxLfo *l, const TaudImxLfoParams *p) { l->p = *p; l->kSync = -1; }
static void lfo_reset(ImxLfo *l) { l->phase = 0; l->held = 0; l->rng = 0x9e3779b9u; }

/* Phase increment per sample (lfoIncrement): floor(R·2^16 / fs) in Hz mode,
 * floor(2^51·bpm / (5·P·fs)) in sync mode, at most 2^31 − 1. */
static int64_t lfo_increment(bool sync, uint32_t rate, int bpm, int fs)
{
    int64_t inc;
    if (!sync) {
        inc = (int64_t)floor(((double)rate * FX16) / fs);
    } else {
        uint64_t num = ((uint64_t)1 << 51) * (uint64_t)(bpm < 0 ? 0 : bpm);
        uint64_t den = 5u * (uint64_t)rate * (uint64_t)fs;
        uint64_t q = num / den;
        inc = q > 0x7fffffffu ? 0x7fffffff : (int64_t)q;
    }
    return inc > 0x7fffffff ? 0x7fffffff : inc < 0 ? 0 : inc;
}

static void lfo_tempo(ImxLfo *l, int bpm, int fs)
{
    int sync = l->p.sync ? 1 : 0;
    if (sync != l->kSync || (int64_t)l->p.rate != l->kRate || fs != l->kFs || (sync == 1 && bpm != l->kBpm)) {
        l->kSync = sync; l->kRate = l->p.rate; l->kBpm = bpm; l->kFs = fs;
        l->inc = lfo_increment(l->p.sync, l->p.rate, bpm, fs);
    }
}

static void lfo_draw(ImxLfo *l)
{
    uint32_t x = l->rng;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    l->rng = x;
    l->held = (x / TWO32) * 2 - 1;
}

static void lfo_step(ImxLfo *l)
{
    int64_t next = l->phase + l->inc;
    if (next >= TWO32I) {
        if (l->p.wave == LFO_RANDOM) lfo_draw(l);
        l->phase = next - TWO32I;
    } else {
        l->phase = next;
    }
}

static void lfo_skip(ImxLfo *l, int n)
{
    int64_t total = l->phase + l->inc * n;
    int64_t wraps = total >> 32, i;
    if (l->p.wave == LFO_RANDOM) for (i = 0; i < wraps; i++) lfo_draw(l);
    l->phase = total - wraps * TWO32I;
}

static double lfo_value(const ImxLfo *l)
{
    double ph = (double)l->phase / TWO32;
    switch (l->p.wave) {
    case LFO_SINE: return js_sin(2 * PI * ph);
    case LFO_TRIANGLE: return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case LFO_SQUARE: return ph < 0.5 ? 1 : -1;
    case LFO_SAW_UP: return 2 * ph - 1;
    case LFO_SAW_DOWN: return 1 - 2 * ph;
    default: return l->held;
    }
}

/* 4-point, 3rd-order Hermite read of a circular buffer at a fractional delay
 * of `delay` samples behind write index `w` (which holds the newest sample).
 * `delay` must be at least 1. */
static double hermite_read(const double *buf, int off, int len, int w, double delay)
{
    int di = (int)floor(delay);
    double f = delay - di;
    int i0 = w - di + 1, i1, i2, i3;
    double xm1, x0, x1, x2, c0, c1, c2, c3;
    if (i0 < 0) i0 += len;
    if (i0 >= len) i0 -= len;
    i1 = i0 - 1; if (i1 < 0) i1 += len;
    i2 = i1 - 1; if (i2 < 0) i2 += len;
    i3 = i2 - 1; if (i3 < 0) i3 += len;
    xm1 = buf[off + i0]; x0 = buf[off + i1]; x1 = buf[off + i2]; x2 = buf[off + i3];
    c0 = x0;
    c1 = 0.5 * (x1 - xm1);
    c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + c0;
}

/* Wet/dry crossfade, in place: data ← wet·(1 − d) + dry·d over [n0, n1). */
static void mix_dry(double *data, const double *dryBuf, int nch, int stride, int n0, int n1, double d)
{
    double w;
    int c, n;
    if (d <= 0) return;
    w = 1 - d;
    for (c = 0; c < nch; c++) {
        int o = c * stride;
        for (n = n0; n < n1; n++) data[o + n] = data[o + n] * w + dryBuf[o + n] * d;
    }
}

static void copy_span(const double *src, double *dst, int nch, int stride, int n0, int n1)
{
    int c, n;
    for (c = 0; c < nch; c++) {
        int o = c * stride;
        for (n = n0; n < n1; n++) dst[o + n] = src[o + n];
    }
}

/* — trim — */

typedef struct { double g; } ImxTrim;

static void trim_configure(ImxTrim *s, const TaudImxEquipment *p) { s->g = te_db_to_gain(p->u.trim.gainDb); }

static void trim_process(ImxTrim *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    double g = s->g;
    int c, n;
    if (g == 1) return;
    for (c = 0; c < ctx->nch; c++) {
        int o = c * stride;
        for (n = n0; n < n1; n++) data[o + n] *= g;
    }
}

/* — the peak of a level over the last W samples, this one included (0
 *   before a reset): the transient shaper's and the expander's detector
 *   (ImxPeakWindow). A monotonic deque of the samples that can still be the
 *   peak, oldest first, levels strictly falling; the sample counter runs
 *   mod 2^31, as the reference's does — */

typedef struct {
    int w, head, len;
    uint32_t t;
    int32_t *idx;
    double *val;
} ImxPeakWin;

static bool peak_init(ImxPeakWin *s, int w)
{
    s->w = w;
    s->head = s->len = 0;
    s->t = 0;
    s->idx = (int32_t *)malloc(sizeof(int32_t) * (size_t)w);
    s->val = (double *)malloc(sizeof(double) * (size_t)w);
    return s->idx != NULL && s->val != NULL;
}

static void peak_free(ImxPeakWin *s)
{
    free(s->idx); free(s->val);
    s->idx = NULL; s->val = NULL; s->w = 0;
}

static void peak_reset(ImxPeakWin *s) { s->head = s->len = 0; s->t = 0; }

/* Take the next sample's level; return the window's peak. */
static double peak_push(ImxPeakWin *s, double l)
{
    int W = s->w, head = s->head, len = s->len, at;
    uint32_t ix = s->t;
    s->t = (ix + 1) & 0x7fffffffu;
    if (len > 0 && ((ix - (uint32_t)s->idx[head]) & 0x7fffffffu) >= (uint32_t)W) {
        head = head + 1 == W ? 0 : head + 1;
        len--;
    }
    while (len > 0) {
        int back = head + len - 1;
        if (back >= W) back -= W;
        if (s->val[back] > l) break;
        len--;
    }
    at = head + len;
    if (at >= W) at -= W;
    s->idx[at] = (int32_t)ix;
    s->val[at] = l;
    s->head = head;
    s->len = len + 1;
    return s->val[head];
}

/* — downward expander, shutting like a gate below its floor (ImxExpander).
 *   The detector hears the bus linked — through the key filter (an RBJ
 *   high-pass, then low-pass, at Q 1/√2) when that is on — as the window's
 *   peak or the compressor's 10 ms RMS. Shut below the floor until the level
 *   is back the hysteresis above it; otherwise the expander's curve under the
 *   threshold. The gain opens at the attack, and closes at the release once
 *   the hold is over — */

typedef struct {
    TaudImxEquipment p;
    ImxPeakWin win;
    TaudBiquad hp, lp;
    double atk, rel, rmsCoef;
    int holdN;
    double g;          /* the gain, dB (≤ 0) */
    int hold;          /* samples of hold left */
    bool shut;
    double ms;         /* RMS detector's mean square */
    bool oom;
    /* Readings for the meter: the span's deepest gain and its loudest
     * detector level, dB. */
    double gr, lvl;
} ImxExpander;

static void expd_init(ImxExpander *s)
{
    memset(s, 0, sizeof *s);
    te_bq_init(&s->hp);
    te_bq_init(&s->lp);
    s->lvl = -120;
}

static void expd_configure(ImxExpander *s, const TaudImxEquipment *p, double rate)
{
    int w = imax(1, (int)js_round(IMX_EXPD_WINDOW_SEC * rate));
    s->p = *p;
    if (w != s->win.w) {
        peak_free(&s->win);
        if (!peak_init(&s->win, w)) s->oom = true;
    }
    s->atk = te_one_pole(p->u.expd.attackMs, rate);
    s->rel = te_one_pole(p->u.expd.releaseMs, rate);
    s->rmsCoef = te_one_pole(10, rate);
    s->holdN = (int)js_round((p->u.expd.holdMs * rate) / 1000);
    te_bq_high_pass(&s->hp, p->u.expd.keyLowCut, SQRT1_2, rate);
    te_bq_low_pass(&s->lp, p->u.expd.keyHighCut, SQRT1_2, rate);
}

static void expd_reset(ImxExpander *s)
{
    if (s->win.w > 0) peak_reset(&s->win);
    te_bq_reset(&s->hp);
    te_bq_reset(&s->lp);
    s->g = 0; s->hold = 0; s->shut = false; s->ms = 0;
    s->gr = 0; s->lvl = -120;
}

static void expd_process(ImxExpander *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, i, c;
    double dry = ctx->dry;
    bool key = s->p.u.expd.keyFilter, peak = s->p.u.expd.detector != COMP_RMS;
    double T = s->p.u.expd.threshDb, slope = (double)s->p.u.expd.ratio - 1, range = s->p.u.expd.rangeDb;
    double floor_ = s->p.u.expd.floorDb, reopen = floor_ + s->p.u.expd.hysteresisDb;
    double g = s->g, ms = s->ms;
    int hold = s->hold;
    bool shut = s->shut;
    double gr = 0, lvl = -120;
    if (s->oom) return;
    if (dry > 0) copy_span(data, ctx->dryBuf, nch, stride, n0, n1);
    for (i = n0; i < n1; i++) {
        double l = 0, sum = 0, level, L, target, k;
        for (c = 0; c < nch; c++) {
            double x = data[c * stride + i];
            if (key) x = te_bq_run(&s->lp, c, te_bq_run(&s->hp, c, x));
            if (peak) { double a = x < 0 ? -x : x; if (a > l) l = a; } else sum += x * x;
        }
        if (peak) level = peak_push(&s->win, l);
        else { ms += (sum / nch - ms) * s->rmsCoef; level = sqrt(ms); }
        L = level > 1e-6 ? 20 * js_log10(level) : -120;
        if (L > lvl) lvl = L;
        if (L < floor_) shut = true;
        else if (L >= reopen) shut = false;
        if (shut) target = -range;
        else if (L < T) {
            double under = (T - L) * slope;
            target = under > range ? -range : -under;
        } else target = 0;
        /* Opening at the attack; closing at the release, once the hold is over. */
        if (target >= g) { g += (target - g) * s->atk; hold = s->holdN; }
        else if (hold > 0) hold--;
        else g += (target - g) * s->rel;
        if (g < gr) gr = g;
        k = te_db_to_gain(g);
        for (c = 0; c < nch; c++) data[c * stride + i] *= k;
    }
    s->g = g; s->hold = hold; s->shut = shut; s->ms = ms;
    s->gr = gr; s->lvl = lvl;
    mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, dry);
}

/* — equaliser: up to eight bands; a cut band a Butterworth cascade of up to
 *   four sections, every other shape one RBJ section — */

typedef struct {
    TaudBiquad secs[IMX_EQ_MAX_BANDS][4];
    TaudBiquad *live[IMX_EQ_MAX_BANDS * 4];
    int nLive;
} ImxEq;

static void eq_init(ImxEq *s)
{
    int i, j;
    for (i = 0; i < IMX_EQ_MAX_BANDS; i++) for (j = 0; j < 4; j++) te_bq_init(&s->secs[i][j]);
    s->nLive = 0;
}

static void eq_configure(ImxEq *s, const TaudImxEquipment *p, double rate)
{
    int i, j;
    s->nLive = 0;
    for (i = 0; i < p->u.eq.n; i++) {
        const TaudImxEqBand *b = &p->u.eq.b[i];
        bool cut;
        int k;
        double qs[4];
        if (!b->on) continue;
        cut = is_cut_shape(b->shape);
        k = cut ? b->slope + 1 : 1;
        /* A 12 dB/octave cut is one section at the band's own Q; a steeper one
         * a maximally flat Butterworth cascade (butterQs). */
        if (cut && k > 1) {
            for (j = 1; j <= k; j++) qs[j - 1] = 1 / (2 * js_cos(((2 * j - 1) * PI) / (4 * k)));
        } else {
            qs[0] = b->q;
        }
        for (j = 0; j < k; j++) {
            TaudBiquad *sec = &s->secs[i][j];
            switch (b->shape) {
            case EQ_HIGH_PASS: te_bq_high_pass(sec, b->freq, qs[j], rate); break;
            case EQ_LOW_PASS: te_bq_low_pass(sec, b->freq, qs[j], rate); break;
            case EQ_LOW_SHELF_: te_bq_low_shelf(sec, b->freq, b->gainDb, b->q, rate); break;
            case EQ_HIGH_SHELF_: te_bq_high_shelf(sec, b->freq, b->gainDb, b->q, rate); break;
            case EQ_NOTCH: te_bq_notch(sec, b->freq, b->q, rate); break;
            default: te_bq_peaking(sec, b->freq, b->gainDb, b->q, rate); break;
            }
            s->live[s->nLive++] = sec;
        }
    }
}

static void eq_reset(ImxEq *s)
{
    int i, j;
    for (i = 0; i < IMX_EQ_MAX_BANDS; i++) for (j = 0; j < 4; j++) te_bq_reset(&s->secs[i][j]);
}

static void eq_process(ImxEq *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int c, n, i, nl = s->nLive;
    if (nl == 0) return;
    for (c = 0; c < ctx->nch; c++) {
        int o = c * stride;
        for (n = n0; n < n1; n++) {
            double y = data[o + n];
            for (i = 0; i < nl; i++) y = te_bq_run(s->live[i], c, y);
            data[o + n] = y;
        }
    }
}

/* — dynamic equaliser: each band a SENSOR (low-pass for the low shelf,
 *   high-pass for the high one, band-pass for the bells) and an ACTOR whose
 *   gain is the static gain plus a dynamic part, its coefficients following
 *   that gain every IMX_CONTROL_PERIOD samples — */

typedef struct {
    TaudImxEquipment p;
    bool hasP;
    double rate;
    TaudBiquad act[IMX_DEQ_BANDS], sense[IMX_DEQ_BANDS];
    double env[IMX_DEQ_BANDS], actor[IMX_DEQ_BANDS], atk[IMX_DEQ_BANDS], rel[IMX_DEQ_BANDS];
    int live[IMX_DEQ_BANDS], nLive;
    int ctl;
    /* Readings for the meter, per band: the dynamic gain the actor applied
     * (signed, the span's extreme) and the loudest sense level, dB. */
    double gr[IMX_DEQ_BANDS], lvl[IMX_DEQ_BANDS];
} ImxDeq;

static void deq_init(ImxDeq *s, int rate)
{
    int i;
    memset(s, 0, sizeof *s);
    for (i = 0; i < IMX_DEQ_BANDS; i++) {
        te_bq_init(&s->act[i]);
        te_bq_init(&s->sense[i]);
        s->actor[i] = 1;
        s->lvl[i] = -120;
    }
    s->rate = rate;
}

static void deq_set_act(ImxDeq *s, int i)
{
    const TaudImxDeqBand *b = &s->p.u.deq.b[i];
    double g = b->gainDb + s->env[i] * s->actor[i];
    if (i == DEQ_LOW_SHELF_BAND) te_bq_low_shelf(&s->act[i], b->freq, g, b->q, s->rate);
    else if (i == DEQ_HIGH_SHELF_BAND) te_bq_high_shelf(&s->act[i], b->freq, g, b->q, s->rate);
    else te_bq_peaking(&s->act[i], b->freq, g, b->q, s->rate);
}

static void deq_configure(ImxDeq *s, const TaudImxEquipment *p, double rate)
{
    int i;
    s->p = *p;
    s->hasP = true;
    s->rate = rate;
    s->nLive = 0;
    for (i = 0; i < IMX_DEQ_BANDS; i++) {
        const TaudImxDeqBand *b = &p->u.deq.b[i];
        if (!b->on) continue;
        s->live[s->nLive++] = i;
        s->atk[i] = te_one_pole(b->attackMs, rate);
        s->actor[i] = te_db_to_gain(b->actorDb);
        s->rel[i] = te_one_pole(b->releaseMs, rate);
        if (i == DEQ_LOW_SHELF_BAND) te_bq_low_pass(&s->sense[i], b->senseFreq, b->senseQ, rate);
        else if (i == DEQ_HIGH_SHELF_BAND) te_bq_high_pass(&s->sense[i], b->senseFreq, b->senseQ, rate);
        else te_bq_band_pass(&s->sense[i], b->senseFreq, b->senseQ, rate);
        deq_set_act(s, i);
    }
}

static void deq_reset(ImxDeq *s)
{
    int i;
    for (i = 0; i < IMX_DEQ_BANDS; i++) {
        te_bq_reset(&s->act[i]);
        te_bq_reset(&s->sense[i]);
        s->env[i] = 0;
    }
    s->ctl = 0;
    memset(s->gr, 0, sizeof s->gr);
    if (s->hasP) for (i = 0; i < s->nLive; i++) deq_set_act(s, s->live[i]);
}

static void deq_process(ImxDeq *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, n, k, c;
    if (s->nLive == 0) return;
    for (k = 0; k < IMX_DEQ_BANDS; k++) { s->gr[k] = 0; s->lvl[k] = -120; }
    for (n = n0; n < n1; n++) {
        if (s->ctl == 0) for (k = 0; k < s->nLive; k++) deq_set_act(s, s->live[k]);
        s->ctl = s->ctl + 1 == IMX_CONTROL_PERIOD ? 0 : s->ctl + 1;
        for (k = 0; k < s->nLive; k++) {
            int i = s->live[k];
            const TaudImxDeqBand *b = &s->p.u.deq.b[i];
            double level = 0, levelDb, over, amt, target, cur;
            bool away;
            /* Sense on the band's INPUT: the bands run in series. */
            for (c = 0; c < nch; c++) {
                double sv = te_bq_run(&s->sense[i], c, data[c * stride + n]);
                double a = sv < 0 ? -sv : sv;
                if (a > level) level = a;
            }
            levelDb = level > 1e-6 ? 20 * js_log10(level) : -120;
            if (levelDb > s->lvl[i]) s->lvl[i] = levelDb;
            over = levelDb - b->threshDb;
            amt = over > 0 ? over * (1 - 1 / (double)b->ratio) : 0;
            if (amt > b->rangeDb) amt = b->rangeDb;
            target = b->boost ? amt : -amt;
            cur = s->env[i];
            away = (target < 0 ? -target : target) > (cur < 0 ? -cur : cur);
            s->env[i] = cur + (target - cur) * (away ? s->atk[i] : s->rel[i]);
            {
                /* The meter reads what the actor applies. */
                double ev = s->env[i] * s->actor[i];
                if ((ev < 0 ? -ev : ev) > (s->gr[i] < 0 ? -s->gr[i] : s->gr[i])) s->gr[i] = ev;
            }
            for (c = 0; c < nch; c++) {
                int j = c * stride + n;
                data[j] = te_bq_run(&s->act[i], c, data[j]);
            }
        }
    }
}

/* — the multiband split the compressor and the transient shaper share
 *   (ImxSplit): Linkwitz–Riley 4th-order crossovers in a cascade, each band
 *   phase-matched through the all-pass of every later crossover, so the bands
 *   sum to the input through one all-pass each — */

#define IMX_SPLIT_MAX 6

typedef struct {
    int nch, bandsN;
    TaudBiquad lp[IMX_SPLIT_MAX - 1][2], hp[IMX_SPLIT_MAX - 1][2];
    TaudBiquad ap[IMX_SPLIT_MAX][IMX_SPLIT_MAX - 2];
    double *bufs[IMX_SPLIT_MAX];
    bool oom;
} ImxSplit;

static void split_free(ImxSplit *s)
{
    int k;
    for (k = 0; k < IMX_SPLIT_MAX; k++) { free(s->bufs[k]); s->bufs[k] = NULL; }
}

/* Make room for n bands; true when the count changed, so the caller's
 * per-band state starts again too. */
static bool split_resize(ImxSplit *s, int n)
{
    int k, j;
    if (n == s->bandsN) return false;
    s->bandsN = n;
    for (k = 0; k < IMX_SPLIT_MAX - 1; k++) {
        te_bq_init(&s->lp[k][0]); te_bq_init(&s->lp[k][1]);
        te_bq_init(&s->hp[k][0]); te_bq_init(&s->hp[k][1]);
    }
    for (k = 0; k < IMX_SPLIT_MAX; k++)
        for (j = 0; j < IMX_SPLIT_MAX - 2; j++) te_bq_init(&s->ap[k][j]);
    split_free(s);
    if (n > 1) {
        for (k = 0; k < n; k++) {
            s->bufs[k] = (double *)calloc((size_t)s->nch * TRACKER_CHUNK, sizeof(double));
            if (s->bufs[k] == NULL) s->oom = true;
        }
    }
    return true;
}

static void split_configure(ImxSplit *s, const float *xover, double rate)
{
    int n = s->bandsN, k, j;
    for (k = 0; k < n - 1; k++) {
        double f = xover[k];
        te_bq_low_pass(&s->lp[k][0], f, SQRT1_2, rate); te_bq_low_pass(&s->lp[k][1], f, SQRT1_2, rate);
        te_bq_high_pass(&s->hp[k][0], f, SQRT1_2, rate); te_bq_high_pass(&s->hp[k][1], f, SQRT1_2, rate);
    }
    for (k = 0; k < n; k++)
        for (j = k + 1; j < n - 1; j++) te_bq_all_pass(&s->ap[k][j - k - 1], xover[j], SQRT1_2, rate);
}

static void split_reset(ImxSplit *s)
{
    int k, j;
    for (k = 0; k < IMX_SPLIT_MAX - 1; k++) {
        te_bq_reset(&s->lp[k][0]); te_bq_reset(&s->lp[k][1]);
        te_bq_reset(&s->hp[k][0]); te_bq_reset(&s->hp[k][1]);
    }
    for (k = 0; k < IMX_SPLIT_MAX; k++)
        for (j = 0; j < IMX_SPLIT_MAX - 2; j++) te_bq_reset(&s->ap[k][j]);
}

/* The bands summed into `out` over [n0, n1). */
static void split_sum(ImxSplit *s, double *out, int stride, int n0, int n1, int nch)
{
    int n = s->bandsN, c, i, k;
    for (c = 0; c < nch; c++) {
        int o = c * stride;
        for (i = n0; i < n1; i++) {
            double sum = 0;
            for (k = 0; k < n; k++) sum += s->bufs[k][o + i];
            out[o + i] = sum;
        }
    }
}

/* Split [n0, n1) of `data` into the bands (s->bufs), and — when `dryBuf` is
 * given — their untouched sum into it. */
static void split_run(ImxSplit *s, const double *data, int stride, int n0, int n1, int nch, double *dryBuf)
{
    int n = s->bandsN, c, i, k, j;
    /* Split: rest ← input; band k ← LR4 low of rest; rest ← LR4 high of rest. */
    for (c = 0; c < nch; c++) {
        int o = c * stride;
        for (i = n0; i < n1; i++) {
            double rest = data[o + i];
            for (k = 0; k < n - 1; k++) {
                s->bufs[k][o + i] = te_bq_run(&s->lp[k][1], c, te_bq_run(&s->lp[k][0], c, rest));
                rest = te_bq_run(&s->hp[k][1], c, te_bq_run(&s->hp[k][0], c, rest));
            }
            s->bufs[n - 1][o + i] = rest;
            /* Phase-match each band to the crossovers it did not pass through. */
            for (k = 0; k < n - 2; k++) {
                double y = s->bufs[k][o + i];
                int naps = n - 2 - k;
                for (j = 0; j < naps; j++) y = te_bq_run(&s->ap[k][j], c, y);
                s->bufs[k][o + i] = y;
            }
        }
    }
    if (dryBuf != NULL) split_sum(s, dryBuf, stride, n0, n1, nch);
}

/* — compressor, one to six bands: one band is the mastering chain's
 *   compressor, linked across the bus; more compress each band of the split
 *   by its own detector and sum them — */

typedef struct {
    TaudImxEquipment p;
    ImxSplit xo;
    TaudCompressor comps[IMX_COMP_MAX_BANDS];
    /* Readings for the meter, per band: the span's deepest reduction and its
     * loudest detector level, dB. */
    double gr[IMX_COMP_MAX_BANDS], lvl[IMX_COMP_MAX_BANDS];
    bool lvlInit;
} ImxComp;

static void comp_configure(ImxComp *s, const TaudImxEquipment *p, double rate)
{
    int n = p->u.comp.n, k;
    s->p = *p;
    if (split_resize(&s->xo, n)) {
        memset(s->comps, 0, sizeof s->comps);
        for (k = 0; k < IMX_COMP_MAX_BANDS; k++) s->comps[k].levelDb = -120;
    }
    split_configure(&s->xo, p->u.comp.xover, rate);
    for (k = 0; k < n; k++) {
        const TaudImxCompBand *b = &p->u.comp.b[k];
        te_comp_configure(&s->comps[k], p->u.comp.detector, b->threshDb, b->ratio, b->attackMs,
                          b->releaseMs, b->kneeDb, b->makeupDb, rate);
    }
}

static void comp_reset(ImxComp *s)
{
    int k;
    split_reset(&s->xo);
    for (k = 0; k < IMX_COMP_MAX_BANDS; k++) te_comp_reset(&s->comps[k]);
    memset(s->gr, 0, sizeof s->gr);
}

static void comp_process(ImxComp *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, n = s->xo.bandsN, i, k, c;
    double dry = ctx->dry;
    for (k = 0; k < IMX_COMP_MAX_BANDS; k++) { s->gr[k] = 0; s->lvl[k] = -120; }
    s->lvlInit = true;
    if (n == 1) {
        TaudCompressor *comp = &s->comps[0];
        if (dry > 0) copy_span(data, ctx->dryBuf, nch, stride, n0, n1);
        if (s->p.u.comp.b[0].on) {
            for (i = n0; i < n1; i++) {
                double g = te_comp_step_planar(comp, data, i, stride, nch);
                for (c = 0; c < nch; c++) data[c * stride + i] *= g;
                if (comp->grDb < s->gr[0]) s->gr[0] = comp->grDb;
                if (comp->levelDb > s->lvl[0]) s->lvl[0] = comp->levelDb;
            }
        }
        mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, dry);
        return;
    }
    if (s->xo.oom) return;
    split_run(&s->xo, data, stride, n0, n1, nch, dry > 0 ? ctx->dryBuf : NULL);
    for (k = 0; k < n; k++) {
        TaudCompressor *comp = &s->comps[k];
        double *b = s->xo.bufs[k];
        if (!s->p.u.comp.b[k].on) continue;     /* an unused band passes, unprocessed */
        for (i = n0; i < n1; i++) {
            double g = te_comp_step_planar(comp, b, i, stride, nch);
            for (c = 0; c < nch; c++) b[c * stride + i] *= g;
            if (comp->grDb < s->gr[k]) s->gr[k] = comp->grDb;
            if (comp->levelDb > s->lvl[k]) s->lvl[k] = comp->levelDb;
        }
    }
    split_sum(&s->xo, data, stride, n0, n1, nch);
    mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, dry);
}

/* — transient shaper, one to six bands over the split: blind to level. Per
 *   band, S rises toward the window's peak P at the attack time and drops
 *   with it at once (transient = 1 − S/P); L rises with P at once and falls
 *   at the sustain time (sustain = 1 − P/L); the gain glides toward
 *   attack × transient + sustain × sustain through a 1 ms one-pole — */

typedef struct {
    TaudImxEquipment p;
    int nch, win;
    double rate;
    ImxSplit xo;
    ImxPeakWin peak[IMX_TSH_MAX_BANDS];
    double S[IMX_TSH_MAX_BANDS], L[IMX_TSH_MAX_BANDS], e[IMX_TSH_MAX_BANDS];
    double atk[IMX_TSH_MAX_BANDS], rel[IMX_TSH_MAX_BANDS];
    double smooth;
    bool oom;
    double gr[IMX_TSH_MAX_BANDS];   /* reading for the meter: signed, the span's extreme */
} ImxTransient;

static void tsh_free(ImxTransient *s)
{
    int k;
    split_free(&s->xo);
    for (k = 0; k < IMX_TSH_MAX_BANDS; k++) peak_free(&s->peak[k]);
}

static void tsh_clear(ImxTransient *s)
{
    int k;
    for (k = 0; k < IMX_TSH_MAX_BANDS; k++) {
        if (s->peak[k].w > 0) peak_reset(&s->peak[k]);
        s->S[k] = s->L[k] = s->e[k] = 0;
    }
}

static void tsh_configure(ImxTransient *s, const TaudImxEquipment *p, double rate)
{
    int n = p->u.tsh.n, k;
    int win = imax(1, (int)js_round(IMX_TSH_WINDOW_SEC * rate));
    s->p = *p;
    if (split_resize(&s->xo, n) || win != s->win || rate != s->rate) {
        s->win = win;
        for (k = 0; k < IMX_TSH_MAX_BANDS; k++) peak_free(&s->peak[k]);
        for (k = 0; k < n; k++) if (!peak_init(&s->peak[k], win)) s->oom = true;
        tsh_clear(s);
    }
    if (s->xo.oom) s->oom = true;
    s->rate = rate;
    s->smooth = te_one_pole(IMX_TSH_SMOOTH_MS, rate);
    split_configure(&s->xo, p->u.tsh.xover, rate);
    for (k = 0; k < n; k++) {
        s->atk[k] = te_one_pole(p->u.tsh.b[k].attackMs, rate);
        s->rel[k] = te_one_pole(p->u.tsh.b[k].releaseMs, rate);
    }
}

static void tsh_reset(ImxTransient *s)
{
    split_reset(&s->xo);
    tsh_clear(s);
    memset(s->gr, 0, sizeof s->gr);
}

/* Band k over [n0, n1) of `b`, in place. */
static void tsh_band(ImxTransient *s, int k, double *b, int stride, int n0, int n1, int nch)
{
    const TaudImxTshBand *band = &s->p.u.tsh.b[k];
    ImxPeakWin *win = &s->peak[k];
    double S = s->S[k], L = s->L[k], e = s->e[k];
    double atk = s->atk[k], rel = s->rel[k], sm = s->smooth;
    double ga = band->attackDb, gs = band->sustainDb, out = band->outDb;
    double gr = s->gr[k];
    int i, c;
    for (i = n0; i < n1; i++) {
        double l = 0, P, tr, su, g;
        for (c = 0; c < nch; c++) {
            double x = b[c * stride + i];
            double a = x < 0 ? -x : x;
            if (a > l) l = a;
        }
        P = peak_push(win, l);
        S = P > S ? S + (P - S) * atk : P;
        L = P < L ? L + (P - L) * rel : P;
        tr = P > 0 ? 1 - S / P : 0;
        su = L > 0 ? 1 - P / L : 0;
        e += (ga * tr + gs * su - e) * sm;
        if ((e < 0 ? -e : e) > (gr < 0 ? -gr : gr)) gr = e;
        g = te_db_to_gain(e + out);
        for (c = 0; c < nch; c++) b[c * stride + i] *= g;
    }
    s->S[k] = S; s->L[k] = L; s->e[k] = e;
    s->gr[k] = gr;
}

static void tsh_process(ImxTransient *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, n = s->xo.bandsN, k;
    double dry = ctx->dry;
    memset(s->gr, 0, sizeof s->gr);
    if (s->oom) return;
    if (n == 1) {
        if (dry > 0) copy_span(data, ctx->dryBuf, nch, stride, n0, n1);
        if (s->p.u.tsh.b[0].on) tsh_band(s, 0, data, stride, n0, n1, nch);
    } else {
        split_run(&s->xo, data, stride, n0, n1, nch, dry > 0 ? ctx->dryBuf : NULL);
        for (k = 0; k < n; k++) if (s->p.u.tsh.b[k].on) tsh_band(s, k, s->xo.bufs[k], stride, n0, n1, nch);
        split_sum(&s->xo, data, stride, n0, n1, nch);
    }
    mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, dry);
}

/* — saturator: first-order antiderivative anti-aliasing,
 *   y[n] = (F(u[n]) − F(u[n−1])) / (u[n] − u[n−1]) — */

static double ln_cosh(double x)
{
    double a = x < 0 ? -x : x;
    return a + js_log1p(js_exp(-2 * a)) - LN2;
}

static double sat_f(int curve, double x)
{
    switch (curve) {
    case SAT_SOFT:
        if (x >= 1) return 1;
        if (x <= -1) return -1;
        return 1.5 * (x - (x * x * x) / 3);
    case SAT_HARD: return x > 1 ? 1 : x < -1 ? -1 : x;
    case SAT_TUBE: return x >= 0 ? js_tanh(x) : 0.5 * js_tanh(2 * x);
    case SAT_FOLD: return js_sin(x);
    default: return js_tanh(x);
    }
}

static double sat_ad(int curve, double x)
{
    switch (curve) {
    case SAT_SOFT: {
        double a = x < 0 ? -x : x, x2;
        if (a >= 1) return a - 0.375;
        x2 = x * x;
        return 1.5 * (x2 * 0.5 - (x2 * x2) / 12);
    }
    case SAT_HARD: {
        double a = x < 0 ? -x : x;
        return a > 1 ? a - 0.5 : x * x * 0.5;
    }
    case SAT_TUBE: return x >= 0 ? ln_cosh(x) : 0.25 * ln_cosh(2 * x);
    case SAT_FOLD: return 1 - js_cos(x);
    default: return ln_cosh(x);
    }
}

#define SAT_EPS 1e-5

typedef struct {
    TaudImxEquipment p;
    bool hasP, hasShape;
    int shapeCurve;
    double shapeBias;
    double u1[TE_MAX_BUS_CH];
    double dcM[TE_MAX_BUS_CH];      /* the DC blocker's running mean */
    double gIn, gOut, fb, dcA;
} ImxSat;

static void sat_configure(ImxSat *s, const TaudImxEquipment *p, double rate)
{
    int c;
    s->p = *p;
    s->hasP = true;
    s->gIn = te_db_to_gain(p->u.sat.inDb) * te_db_to_gain(p->u.sat.driveDb);
    s->gOut = te_db_to_gain(p->u.sat.outDb);
    s->fb = sat_f(p->u.sat.curve, p->u.sat.bias);
    /* The mix tool's DC blocker follows every curve (Microtone 4.7.0): the
     * offset an uneven shape or a bias adds depends on the signal, and a
     * biased INPUT comes out biased by any curve — either way an offset would
     * eat the headroom of a limiter after it. */
    s->dcA = (IMX_DC_K * IMX_DC_HZ) / rate;
    if (!s->hasShape || s->shapeCurve != p->u.sat.curve || s->shapeBias != p->u.sat.bias) {
        s->hasShape = true;
        s->shapeCurve = p->u.sat.curve;
        s->shapeBias = p->u.sat.bias;
        for (c = 0; c < TE_MAX_BUS_CH; c++) s->u1[c] = p->u.sat.bias;
    }
}

static void sat_reset(ImxSat *s)
{
    int c;
    for (c = 0; c < TE_MAX_BUS_CH; c++) {
        s->u1[c] = s->hasP ? s->p.u.sat.bias : 0;
        s->dcM[c] = 0;
    }
}

static void sat_process(ImxSat *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, c, n;
    int curve = s->p.u.sat.curve;
    double bias = s->p.u.sat.bias, gIn = s->gIn, gOut = s->gOut, fb = s->fb;
    double a = s->dcA, b = 1 - a;
    if (ctx->dry > 0) copy_span(data, ctx->dryBuf, nch, stride, n0, n1);
    for (c = 0; c < nch; c++) {
        int o = c * stride;
        double u1 = s->u1[c];
        double F1 = sat_ad(curve, u1);
        double m = s->dcM[c];
        for (n = n0; n < n1; n++) {
            double u = data[o + n] * gIn + bias;
            double d = u - u1;
            double y, F0;
            if (d > SAT_EPS || d < -SAT_EPS) {
                F0 = sat_ad(curve, u);
                y = (F0 - F1) / d;
            } else {
                F0 = sat_ad(curve, u);
                y = sat_f(curve, (u + u1) * 0.5);
            }
            u1 = u; F1 = F0;
            y -= fb;
            /* Opus's dc_reject, as the mix tool runs it. */
            {
                double yy = y - m;
                m = a * y + b * m;
                data[o + n] = yy * gOut;
            }
        }
        s->u1[c] = u1;
        s->dcM[c] = m;
    }
    mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, ctx->dry);
}

/* — unison: 2…8 delay-line pitch shifters, two taps half a window apart
 *   sweeping it at (1 − ratio) samples per sample, crossfaded by sin² — */

#define UNIS_WINDOW_SEC 0.025

typedef struct {
    TaudImxEquipment p;
    bool hasP;
    int nch, len, w, win, ctl, rate;
    double *buf;
    int64_t phase[IMX_UNIS_MAX_VOICES], inc[IMX_UNIS_MAX_VOICES];
    double pan[IMX_UNIS_MAX_VOICES], pos[IMX_UNIS_MAX_VOICES];
    ImxLfo lfoD, lfoW;
    double xfade[4097];         /* sin²(π·i/4096) */
    bool oom;
    double curCents, curWidth;  /* what the last control period set, for the meter */
} ImxUnison;

static void unis_init(ImxUnison *s, int nch, int rate)
{
    int i;
    memset(s, 0, sizeof *s);
    s->nch = nch;
    s->rate = rate;
    lfo_init(&s->lfoD);
    lfo_init(&s->lfoW);
    for (i = 0; i <= 4096; i++) { double sn = js_sin((PI * i) / 4096); s->xfade[i] = sn * sn; }
}

static double unis_xfade_at(const ImxUnison *s, int64_t phase)
{
    double x = ((double)phase / TWO32) * 4096;
    int i = (int)floor(x);
    double f = x - i;
    return s->xfade[i] + (s->xfade[i + 1] - s->xfade[i]) * f;
}

/* Where voice k of n sits in [−1, 1] (unisonPositions): uniform spacing
 * blended toward a raised-cosine bell's quantiles. */
static void unison_positions(int n, double spacing, double *out)
{
    int k, it;
    if (n < 4) spacing = 0;
    for (k = 0; k < n; k++) {
        double q = n == 1 ? 0.5 : (double)k / (n - 1);
        double u = 2 * q - 1, lo = -1, hi = 1, b;
        for (it = 0; it < 64; it++) {
            double mid = (lo + hi) * 0.5;
            double F = (mid + 1) * 0.5 + js_sin(PI * mid) / (2 * PI);
            if (F < q) lo = mid; else hi = mid;
        }
        b = q == 0 ? -1 : q == 1 ? 1 : (lo + hi) * 0.5;
        out[k] = (1 - spacing) * u + spacing * b;
    }
}

static void unis_configure(ImxUnison *s, const TaudImxEquipment *p, double rate)
{
    int win = (int)js_round(UNIS_WINDOW_SEC * rate);
    s->p = *p;
    s->hasP = true;
    s->rate = (int)rate;
    if (win != s->win) {
        s->win = win;
        s->len = win + 8;
        free(s->buf);
        s->buf = (double *)calloc((size_t)s->nch * s->len, sizeof(double));
        if (s->buf == NULL) s->oom = true;
        s->w = 0;
    }
    unison_positions(p->u.unis.voices, p->u.unis.spacing, s->pos);
    lfo_configure(&s->lfoD, &p->u.unis.detuneLfo);
    lfo_configure(&s->lfoW, &p->u.unis.widthLfo);
    s->ctl = 0;
}

static void unis_reset(ImxUnison *s)
{
    int k;
    if (s->buf != NULL) memset(s->buf, 0, sizeof(double) * (size_t)s->nch * s->len);
    s->w = 0;
    /* Staggered start: voices that began in step would comb against each other. */
    for (k = 0; k < IMX_UNIS_MAX_VOICES; k++) s->phase[k] = (int64_t)floor((k * TWO32) / IMX_UNIS_MAX_VOICES);
    lfo_reset(&s->lfoD);
    lfo_reset(&s->lfoW);
    s->ctl = 0;
}

static void unis_retrigger(ImxUnison *s)
{
    if (s->p.u.unis.detuneLfo.retrigger) s->lfoD.phase = 0;
    if (s->p.u.unis.widthLfo.retrigger) s->lfoW.phase = 0;
}

static void unis_skip(ImxUnison *s, int frames, const ImxCtx *ctx)
{
    lfo_tempo(&s->lfoD, ctx->bpm, s->rate); lfo_tempo(&s->lfoW, ctx->bpm, s->rate);
    lfo_skip(&s->lfoD, frames); lfo_skip(&s->lfoW, frames);
}

static void unis_control(ImxUnison *s)
{
    const TaudImxEquipment *p = &s->p;
    int nv = p->u.unis.voices, k;
    double dl = lfo_value(&s->lfoD) * p->u.unis.detuneLfo.depth;
    double wl = lfo_value(&s->lfoW) * p->u.unis.widthLfo.depth;
    double cents = p->u.unis.detune * (1 + dl);
    double width = p->u.unis.width * (1 + wl);
    cents = cents < 0 ? 0 : cents > 100 ? 100 : cents;
    width = width < 0 ? 0 : width > 1 ? 1 : width;
    s->curCents = cents;
    s->curWidth = width;
    for (k = 0; k < nv; k++) {
        double r = js_pow(2, (s->pos[k] * cents) / 1200);
        /* (1 − r) samples per sample across a window of `win`, as a U32 phase. */
        s->inc[k] = (int64_t)js_round(((1 - r) * TWO32) / s->win);
        s->pan[k] = s->pos[k] * width;
    }
}

static int64_t wrap_phase(int64_t nx)
{
    if (nx >= TWO32I) nx -= TWO32I;
    else if (nx < 0) nx += TWO32I;
    return nx;
}

static void unis_process(ImxUnison *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, nv = s->p.u.unis.voices, n, k, c;
    int len = s->len, win = s->win;
    double *buf = s->buf;
    double norm = 1 / sqrt((double)nv);
    bool stereo = ctx->stereo && nch == 2;
    if (ctx->dry > 0) copy_span(data, ctx->dryBuf, nch, stride, n0, n1);
    lfo_tempo(&s->lfoD, ctx->bpm, s->rate);
    lfo_tempo(&s->lfoW, ctx->bpm, s->rate);
    if (s->oom) return;
    for (n = n0; n < n1; n++) {
        int w;
        if (s->ctl == 0) unis_control(s);
        s->ctl = s->ctl + 1 == IMX_CONTROL_PERIOD ? 0 : s->ctl + 1;
        lfo_step(&s->lfoD);
        lfo_step(&s->lfoW);
        w = s->w;
        for (c = 0; c < nch; c++) buf[c * len + w] = data[c * stride + n];
        if (stereo) {
            double L = 0, R = 0;
            for (k = 0; k < nv; k++) {
                int64_t ph = s->phase[k];
                int64_t ph2 = ph >= 2147483648LL ? ph - 2147483648LL : ph + 2147483648LL;
                double g1 = unis_xfade_at(s, ph);
                double d1 = 2 + ((double)ph / TWO32) * win;
                double d2 = 2 + ((double)ph2 / TWO32) * win;
                double yl = hermite_read(buf, 0, len, w, d1) * g1 + hermite_read(buf, 0, len, w, d2) * (1 - g1);
                double yr = hermite_read(buf, len, len, w, d1) * g1 + hermite_read(buf, len, len, w, d2) * (1 - g1);
                /* A pair moved as a pair, its image intact at the centre. */
                double pp = s->pan[k];
                if (pp >= 0) { L += yl * (1 - pp); R += yr + yl * pp; }
                else { L += yl + yr * -pp; R += yr * (1 + pp); }
                s->phase[k] = wrap_phase(ph + s->inc[k]);
            }
            data[n] = L * norm;
            data[stride + n] = R * norm;
        } else {
            for (c = 0; c < nch; c++) {
                double sum = 0;
                for (k = 0; k < nv; k++) {
                    int64_t ph = s->phase[k];
                    int64_t ph2 = ph >= 2147483648LL ? ph - 2147483648LL : ph + 2147483648LL;
                    double g1 = unis_xfade_at(s, ph);
                    sum += hermite_read(buf, c * len, len, w, 2 + ((double)ph / TWO32) * win) * g1 +
                           hermite_read(buf, c * len, len, w, 2 + ((double)ph2 / TWO32) * win) * (1 - g1);
                }
                data[c * stride + n] = sum * norm;
            }
            for (k = 0; k < nv; k++) s->phase[k] = wrap_phase(s->phase[k] + s->inc[k]);
        }
        s->w = w + 1 == len ? 0 : w + 1;
    }
    mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, ctx->dry);
}

/* — reverb: an eight-line feedback delay network, Householder matrix, a
 *   damping one-pole in every line, four Schroeder all-passes of input
 *   diffusion and a pre-delay — */

static const int VERB_LINES[8] = { 2473, 2767, 3217, 3557, 3907, 4127, 4639, 4999 };
static const int VERB_DIFFUSERS[4] = { 245, 371, 479, 605 };
#define VERB_DIFFUSE_G 0.5

typedef struct {
    int nch, rate, ins;
    bool allocated, oom;
    double *lines[8];
    int lineLen[8], lens[8], pos[8];
    double g[8], z[8], damp;
    double *diff[2][4];
    int diffLen[2][4], dpos[2][4];
    double *pre;
    int preLen, prePos, preD;
    double o[8], f[8];
} ImxVerb;

static void verb_free(ImxVerb *s)
{
    int i, c;
    for (i = 0; i < 8; i++) { free(s->lines[i]); s->lines[i] = NULL; }
    for (c = 0; c < 2; c++) for (i = 0; i < 4; i++) { free(s->diff[c][i]); s->diff[c][i] = NULL; }
    free(s->pre);
    s->pre = NULL;
}

static void verb_configure(ImxVerb *s, const TaudImxEquipment *p, double rate)
{
    int i, c;
    double scale;
    s->ins = s->nch == 2 ? 2 : 1;
    if ((int)rate != s->rate || !s->allocated) {
        verb_free(s);
        s->rate = (int)rate;
        s->allocated = true;
        for (i = 0; i < 8; i++) {
            s->lineLen[i] = (int)ceil((VERB_LINES[i] * rate) / 48000) + 2;
            s->lines[i] = (double *)calloc((size_t)s->lineLen[i], sizeof(double));
            if (s->lines[i] == NULL) s->oom = true;
        }
        for (c = 0; c < s->ins; c++) {
            for (i = 0; i < 4; i++) {
                int l = (int)js_round((VERB_DIFFUSERS[i] * rate) / 48000);
                s->diffLen[c][i] = l > 1 ? l : 1;
                s->diff[c][i] = (double *)calloc((size_t)s->diffLen[c][i], sizeof(double));
                if (s->diff[c][i] == NULL) s->oom = true;
                s->dpos[c][i] = 0;
            }
        }
        s->preLen = (int)ceil(IMX_PREDELAY_MAX_SEC * rate) + 2;
        s->pre = (double *)calloc((size_t)s->ins * s->preLen, sizeof(double));
        if (s->pre == NULL) s->oom = true;
    }
    scale = (0.15 + 0.85 * p->u.verb.size) * (rate / 48000);
    for (i = 0; i < 8; i++) {
        int len = (int)js_round(VERB_LINES[i] * scale);
        if (len > s->lineLen[i] - 1) len = s->lineLen[i] - 1;
        if (len < 16) len = 16;
        s->lens[i] = len;
        s->g[i] = js_pow(10, (-3 * len) / (p->u.verb.decay * rate));
        if (s->pos[i] >= s->lineLen[i]) s->pos[i] = 0;
    }
    s->damp = 1 - js_exp((-2 * PI * p->u.verb.damping) / rate);
    /* Pre-delay in whole samples, from 16.16 seconds: floor(P·fs / 2^16). */
    s->preD = (int)floor(((double)p->u.verb.preDelay * rate) / FX16);
    if (s->preD > s->preLen - 1) s->preD = s->preLen - 1;
}

static int verb_memory(const ImxVerb *s)
{
    int m = s->preD, i;
    for (i = 0; i < 8; i++) m += s->lens[i];
    for (i = 0; i < 4; i++) m += (int)js_round(((double)VERB_DIFFUSERS[i] * s->rate) / 48000);
    return m;
}

static void verb_reset(ImxVerb *s)
{
    int i, c;
    if (!s->allocated || s->oom) return;
    for (i = 0; i < 8; i++) { memset(s->lines[i], 0, sizeof(double) * (size_t)s->lineLen[i]); s->pos[i] = 0; s->z[i] = 0; }
    for (c = 0; c < s->ins; c++) {
        for (i = 0; i < 4; i++) {
            memset(s->diff[c][i], 0, sizeof(double) * (size_t)s->diffLen[c][i]);
            s->dpos[c][i] = 0;
        }
    }
    memset(s->pre, 0, sizeof(double) * (size_t)s->ins * s->preLen);
    s->prePos = 0;
}

static double verb_diffuse(ImxVerb *s, int c, double x)
{
    int i;
    for (i = 0; i < 4; i++) {
        double *d = s->diff[c][i];
        int k = s->dpos[c][i];
        double v = d[k];
        double y = v - VERB_DIFFUSE_G * x;
        d[k] = x + VERB_DIFFUSE_G * y;
        s->dpos[c][i] = k + 1 == s->diffLen[c][i] ? 0 : k + 1;
        x = y;
    }
    return x;
}

static void verb_process(ImxVerb *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, n, i, c;
    bool stereo = s->ins == 2;
    int preLen = s->preLen, preD = s->preD;
    double damp = s->damp;
    if (ctx->dry > 0) copy_span(data, ctx->dryBuf, nch, stride, n0, n1);
    if (s->oom) return;
    for (n = n0; n < n1; n++) {
        double inL, inR, dL, dR = 0, xL, xR, sum = 0, h;
        int pp, rp;
        if (stereo) { inL = data[n]; inR = data[stride + n]; }
        else {
            double sm = 0;
            for (c = 0; c < nch; c++) sm += data[c * stride + n];
            inL = sm / nch; inR = 0;
        }
        pp = s->prePos;
        rp = pp - preD < 0 ? pp - preD + preLen : pp - preD;
        s->pre[pp] = inL;
        dL = s->pre[rp];
        if (stereo) { s->pre[preLen + pp] = inR; dR = s->pre[preLen + rp]; }
        s->prePos = pp + 1 == preLen ? 0 : pp + 1;
        xL = verb_diffuse(s, 0, dL);
        xR = stereo ? verb_diffuse(s, 1, dR) : xL;
        for (i = 0; i < 8; i++) {
            double *line = s->lines[i];
            int r = s->pos[i] - s->lens[i];
            double v;
            if (r < 0) r += s->lineLen[i];
            v = line[r];
            s->o[i] = v;
            s->z[i] += (v - s->z[i]) * damp;
            s->f[i] = s->z[i] * s->g[i];
            sum += s->f[i];
        }
        /* Householder (I − (2/8)·11ᵀ), written back with the input. */
        h = sum * 0.25;
        for (i = 0; i < 8; i++) {
            double inj = stereo ? ((i & 1) == 0 ? xL : xR) : xL;
            s->lines[i][s->pos[i]] = s->f[i] - h + inj * 0.5;
            s->pos[i] = s->pos[i] + 1 == s->lineLen[i] ? 0 : s->pos[i] + 1;
        }
        if (stereo) {
            data[n] = 0.5 * (s->o[0] - s->o[2] + s->o[4] - s->o[6]);
            data[stride + n] = 0.5 * (s->o[1] - s->o[3] + s->o[5] - s->o[7]);
        } else {
            for (c = 0; c < nch; c++) data[c * stride + n] = ((c & 8) ? -0.5 : 0.5) * s->o[c & 7];
        }
    }
    mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, ctx->dry);
}

/* — tape delay: 16.16 seconds or quarter ticks; the read head glides to a new
 *   time by 1/2048 of the distance a sample; the feedback through a low cut,
 *   a high cut and a soft saturator; wow and flutter two fixed sines — */

#define WOW_RATE (FX16 / 2)                 /* 0.5 Hz */
#define FLUTTER_RATE (6 * FX16 + FX16 / 2)  /* 6.5 Hz */
#define WOW_SEC 0.002
#define FLUTTER_SEC 0.00015
#define GLIDE_SHIFT 2048

typedef struct {
    TaudImxEquipment p;
    int nch, len, w, rate;
    double *buf;
    int64_t d, t;               /* current and target delay, 1/65536 samples */
    bool started, oom;
    int64_t wow, flutter, wowInc, flutInc;
    TaudBiquad lc, hc;
    double fbs[TE_MAX_BUS_CH], xs[TE_MAX_BUS_CH];
    double g;
} ImxDelay;

static void delay_init(ImxDelay *s, int nch, int rate)
{
    memset(s, 0, sizeof *s);
    s->nch = nch;
    s->rate = rate;
    te_bq_init(&s->lc);
    te_bq_init(&s->hc);
    s->g = 1;
}

static void delay_configure(ImxDelay *s, const TaudImxEquipment *p, double rate)
{
    s->p = *p;
    if ((int)rate != s->rate || s->buf == NULL) {
        s->rate = (int)rate;
        s->len = (int)ceil(IMX_DELAY_MAX_SEC * rate) + 16;
        free(s->buf);
        s->buf = (double *)calloc((size_t)s->nch * s->len, sizeof(double));
        if (s->buf == NULL) s->oom = true;
        s->w = 0;
        s->started = false;
    }
    te_bq_high_pass(&s->lc, p->u.dlay.lowCut, SQRT1_2, rate);
    te_bq_low_pass(&s->hc, p->u.dlay.highCut, SQRT1_2, rate);
    s->g = te_db_to_gain(p->u.dlay.driveDb);
    s->wowInc = (int64_t)floor(((double)WOW_RATE * FX16) / rate);
    s->flutInc = (int64_t)floor(((double)FLUTTER_RATE * FX16) / rate);
}

static void delay_reset(ImxDelay *s)
{
    if (s->buf != NULL) memset(s->buf, 0, sizeof(double) * (size_t)s->nch * s->len);
    s->w = 0;
    te_bq_reset(&s->lc);
    te_bq_reset(&s->hc);
    memset(s->fbs, 0, sizeof s->fbs);
    s->wow = 0;
    s->flutter = 0;
    s->started = false;
}

/* The target delay in 1/65536 samples for this tempo. */
static int64_t delay_target(const ImxDelay *s, int bpm)
{
    double fs = s->rate, t;
    int64_t ti, lo = 2 * FX16, hi = (int64_t)(s->len - 8) * FX16;
    if (s->p.u.dlay.sync) {
        /* P quarter ticks · (fs · 2.5 / bpm) / 4 samples, ×2^16: P·fs·5 / (8·bpm). */
        t = floor(((double)s->p.u.dlay.time * fs * 5) / (8.0 * bpm));
    } else {
        t = (double)s->p.u.dlay.time * fs;
    }
    ti = (int64_t)t;
    return ti < lo ? lo : ti > hi ? hi : ti;
}

static void delay_skip(ImxDelay *s, int frames)
{
    s->wow = (s->wow + s->wowInc * frames) % TWO32I;
    s->flutter = (s->flutter + s->flutInc * frames) % TWO32I;
}

static void delay_process(ImxDelay *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    int nch = ctx->nch, len = s->len, n, c;
    double *buf = s->buf;
    double fs = s->rate, fb = s->p.u.dlay.feedback, g = s->g;
    double wowAmp = s->p.u.dlay.wow * WOW_SEC * fs;
    double flutAmp = s->p.u.dlay.wow * FLUTTER_SEC * fs;
    bool pingPong = s->p.u.dlay.pingPong && ctx->stereo && nch == 2;
    /* The line the mid goes into (0 left, 1 right) and the other one. */
    int pa = pingPong && s->p.u.dlay.pingRight ? 1 : 0, pb = 1 - pa;
    if (ctx->dry > 0) copy_span(data, ctx->dryBuf, nch, stride, n0, n1);
    if (s->oom) return;
    s->t = delay_target(s, ctx->bpm);
    if (!s->started) { s->d = s->t; s->started = true; }
    for (n = n0; n < n1; n++) {
        int64_t diff = s->t - s->d;
        double delay;
        int w;
        /* The glide: integer arithmetic (JS: exact binary64 integers). */
        if (diff >= GLIDE_SHIFT || diff <= -GLIDE_SHIFT) s->d += diff / GLIDE_SHIFT;
        else s->d = s->t;
        delay = (double)s->d / FX16;
        if (wowAmp != 0) {
            delay += wowAmp * js_sin((2 * PI * (double)s->wow) / TWO32) +
                     flutAmp * js_sin((2 * PI * (double)s->flutter) / TWO32);
        }
        if (delay < 2) delay = 2;
        s->wow += s->wowInc; if (s->wow >= TWO32I) s->wow -= TWO32I;
        s->flutter += s->flutInc; if (s->flutter >= TWO32I) s->flutter -= TWO32I;
        w = s->w;
        /* Read every channel first (the write below may cross them). The
         * newest sample in the line is the PREVIOUS one. */
        for (c = 0; c < nch; c++) {
            double y, f;
            s->xs[c] = data[c * stride + n];
            y = hermite_read(buf, c * len, len, w == 0 ? len - 1 : w - 1, delay - 1);
            f = te_bq_run(&s->hc, c, te_bq_run(&s->lc, c, y * fb));
            f = js_tanh(g * f) / g;
            s->fbs[c] = f;
            data[c * stride + n] = y;
        }
        if (pingPong) {
            double mid = (s->xs[0] + s->xs[1]) * 0.5;
            buf[pa * len + w] = mid + s->fbs[pb];
            buf[pb * len + w] = s->fbs[pa];
        } else {
            for (c = 0; c < nch; c++) buf[c * len + w] = s->xs[c] + s->fbs[c];
        }
        s->w = w + 1 == len ? 0 : w + 1;
    }
    mix_dry(data, ctx->dryBuf, nch, stride, n0, n1, ctx->dry);
}

/* — limiter: the mastering chain's look-ahead limiter, after a gain — */

typedef struct { TaudLimiter stage; double g; } ImxLimiter;

static void limi_configure(ImxLimiter *s, const TaudImxEquipment *p, double rate)
{
    s->g = te_db_to_gain(p->u.lim.gainDb);
    te_lim_configure(&s->stage, p->u.lim.ceilingDb, p->u.lim.truePeak, p->u.lim.releaseMs, rate);
}

static void limi_process(ImxLimiter *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    double g = s->g;
    int nch = ctx->nch, n, c;
    if (s->stage.d == 0) return;
    s->stage.grDb = 0;
    for (n = n0; n < n1; n++) {
        if (g != 1) for (c = 0; c < nch; c++) data[c * stride + n] *= g;
        te_lim_step_planar(&s->stage, data, n, stride);
    }
}

/* — mix tool: DC removal (Opus's dc_reject), gain, mid/side width, swap and
 *   polarity; an ambisonic bus's width is surround width — */

typedef struct { TaudImxEquipment p; double g, a; double m[TE_MAX_BUS_CH]; } ImxMixTool;

static void mx_configure(ImxMixTool *s, const TaudImxEquipment *p, double rate)
{
    s->p = *p;
    s->g = te_db_to_gain(p->u.mx.gainDb);
    s->a = (IMX_DC_K * IMX_DC_HZ) / rate;
}

static void mx_process(ImxMixTool *s, double *data, int stride, int n0, int n1, const ImxCtx *ctx)
{
    const TaudImxEquipment *p = &s->p;
    int nch = ctx->nch, n, c;
    double g = s->g, gg;
    if (p->u.mx.removeDc) {
        double a = s->a, b = 1 - a;
        for (c = 0; c < nch; c++) {
            int o = c * stride;
            double m = s->m[c];
            for (n = n0; n < n1; n++) {
                double x = data[o + n];
                data[o + n] = x - m;
                m = a * x + b * m;
            }
            s->m[c] = m;
        }
    }
    if (ctx->stereo && nch == 2) {
        double gl = p->u.mx.invL ? -g : g;
        double gr = p->u.mx.invR ? -g : g;
        double w = p->u.mx.width;
        for (n = n0; n < n1; n++) {
            double l = data[n], r = data[stride + n];
            if (p->u.mx.swap) { double t = l; l = r; r = t; }
            if (w != 1) {
                double m = (l + r) * 0.5;
                double sd = (l - r) * 0.5 * w;
                l = m + sd; r = m - sd;
            }
            data[n] = l * gl;
            data[stride + n] = r * gr;
        }
        return;
    }
    if (ctx->ambisonic && p->u.mx.width != 1) {
        double w = p->u.mx.width;
        for (c = 1; c < nch; c++) {
            int o = c * stride;
            for (n = n0; n < n1; n++) data[o + n] *= w;
        }
    }
    gg = p->u.mx.invL && p->u.mx.invR ? -g : g;
    if (gg == 1) return;
    for (c = 0; c < nch; c++) {
        int o = c * stride;
        for (n = n0; n < n1; n++) data[o + n] *= gg;
    }
}

/* ── the chain (InstrumentChain) ─────────────────────────────────────────── */

struct TaudImxChain {
    int rate, nch;
    bool stereo, ambisonic;
    void *stage[IMX_KINDS];         /* made the first time the piece is in */
    int active[IMX_KINDS];
    double activeDry[IMX_KINDS];
    int nActive;
    double *dryBuf;
    bool idle;
    int silentRun, idleAfter;
    ImxCtx ctx;
    bool oom;
    /* The Mixing tab's taps metering this chain's bus while it runs (two when
     * both seats meter one bus), or NULL. */
    struct TaudImixTap *probe[2];
};

static void *make_stage(TaudImxChain *c, int k)
{
    void *s = NULL;
    switch (k) {
    case IMX_ITRM: s = calloc(1, sizeof(ImxTrim)); break;
    case IMX_EXPD: s = malloc(sizeof(ImxExpander)); if (s) expd_init((ImxExpander *)s); break;
    case IMX_TSH1: s = calloc(1, sizeof(ImxTransient)); if (s) ((ImxTransient *)s)->xo.nch = c->nch; break;
    case IMX_EQU1: case IMX_EQU2: s = malloc(sizeof(ImxEq)); if (s) eq_init((ImxEq *)s); break;
    case IMX_DEQ1: case IMX_DEQ2: s = malloc(sizeof(ImxDeq)); if (s) deq_init((ImxDeq *)s, c->rate); break;
    case IMX_COMP: s = calloc(1, sizeof(ImxComp)); if (s) ((ImxComp *)s)->xo.nch = c->nch; break;
    case IMX_SATU: s = calloc(1, sizeof(ImxSat)); break;
    case IMX_UNIS: s = malloc(sizeof(ImxUnison)); if (s) unis_init((ImxUnison *)s, c->nch, c->rate); break;
    case IMX_VERB: s = calloc(1, sizeof(ImxVerb)); if (s) ((ImxVerb *)s)->nch = c->nch; break;
    case IMX_DLAY: s = malloc(sizeof(ImxDelay)); if (s) delay_init((ImxDelay *)s, c->nch, c->rate); break;
    case IMX_LIMI: s = calloc(1, sizeof(ImxLimiter)); if (s) te_lim_init(&((ImxLimiter *)s)->stage, c->nch); break;
    default: s = calloc(1, sizeof(ImxMixTool)); break;
    }
    return s;
}

static void free_stage(int k, void *s)
{
    if (s == NULL) return;
    switch (k) {
    case IMX_EXPD: peak_free(&((ImxExpander *)s)->win); break;
    case IMX_TSH1: tsh_free((ImxTransient *)s); break;
    case IMX_COMP: split_free(&((ImxComp *)s)->xo); break;
    case IMX_UNIS: free(((ImxUnison *)s)->buf); break;
    case IMX_VERB: verb_free((ImxVerb *)s); break;
    case IMX_DLAY: free(((ImxDelay *)s)->buf); break;
    case IMX_LIMI: te_lim_free(&((ImxLimiter *)s)->stage); break;
    default: break;
    }
    free(s);
}

static void stage_configure(TaudImxChain *c, int k, const TaudImxEquipment *e)
{
    void *s = c->stage[k];
    double rate = c->rate;
    switch (k) {
    case IMX_ITRM: trim_configure((ImxTrim *)s, e); break;
    case IMX_EQU1: case IMX_EQU2: eq_configure((ImxEq *)s, e, rate); break;
    case IMX_DEQ1: case IMX_DEQ2: deq_configure((ImxDeq *)s, e, rate); break;
    case IMX_EXPD: expd_configure((ImxExpander *)s, e, rate); if (((ImxExpander *)s)->oom) c->oom = true; break;
    case IMX_TSH1: tsh_configure((ImxTransient *)s, e, rate); if (((ImxTransient *)s)->oom) c->oom = true; break;
    case IMX_COMP: comp_configure((ImxComp *)s, e, rate); if (((ImxComp *)s)->xo.oom) c->oom = true; break;
    case IMX_SATU: sat_configure((ImxSat *)s, e, rate); break;
    case IMX_UNIS: unis_configure((ImxUnison *)s, e, rate); if (((ImxUnison *)s)->oom) c->oom = true; break;
    case IMX_VERB: verb_configure((ImxVerb *)s, e, rate); if (((ImxVerb *)s)->oom) c->oom = true; break;
    case IMX_DLAY: delay_configure((ImxDelay *)s, e, rate); if (((ImxDelay *)s)->oom) c->oom = true; break;
    case IMX_LIMI: limi_configure((ImxLimiter *)s, e, rate); if (((ImxLimiter *)s)->stage.d == 0) c->oom = true; break;
    default: mx_configure((ImxMixTool *)s, e, rate); break;
    }
}

static void stage_reset(int k, void *s)
{
    switch (k) {
    case IMX_EQU1: case IMX_EQU2: eq_reset((ImxEq *)s); break;
    case IMX_DEQ1: case IMX_DEQ2: deq_reset((ImxDeq *)s); break;
    case IMX_EXPD: expd_reset((ImxExpander *)s); break;
    case IMX_TSH1: tsh_reset((ImxTransient *)s); break;
    case IMX_COMP: comp_reset((ImxComp *)s); break;
    case IMX_SATU: sat_reset((ImxSat *)s); break;
    case IMX_UNIS: unis_reset((ImxUnison *)s); break;
    case IMX_VERB: verb_reset((ImxVerb *)s); break;
    case IMX_DLAY: delay_reset((ImxDelay *)s); break;
    case IMX_LIMI: te_lim_reset(&((ImxLimiter *)s)->stage); break;
    case IMX_MXTL: memset(((ImxMixTool *)s)->m, 0, sizeof ((ImxMixTool *)s)->m); break;
    default: break;
    }
}

static int stage_memory(int k, const void *s)
{
    switch (k) {
    case IMX_UNIS: return ((const ImxUnison *)s)->len;
    case IMX_VERB: return verb_memory((const ImxVerb *)s);
    case IMX_DLAY: return ((const ImxDelay *)s)->len;
    case IMX_LIMI: return ((const ImxLimiter *)s)->stage.d == 0 ? 0 : 2 * ((const ImxLimiter *)s)->stage.d;
    default: return 0;
    }
}

static void stage_process(TaudImxChain *c, int k, double *data, int stride, int n0, int n1)
{
    void *s = c->stage[k];
    const ImxCtx *ctx = &c->ctx;
    switch (k) {
    case IMX_ITRM: trim_process((ImxTrim *)s, data, stride, n0, n1, ctx); break;
    case IMX_EQU1: case IMX_EQU2: eq_process((ImxEq *)s, data, stride, n0, n1, ctx); break;
    case IMX_DEQ1: case IMX_DEQ2: deq_process((ImxDeq *)s, data, stride, n0, n1, ctx); break;
    case IMX_EXPD: expd_process((ImxExpander *)s, data, stride, n0, n1, ctx); break;
    case IMX_TSH1: tsh_process((ImxTransient *)s, data, stride, n0, n1, ctx); break;
    case IMX_COMP: comp_process((ImxComp *)s, data, stride, n0, n1, ctx); break;
    case IMX_SATU: sat_process((ImxSat *)s, data, stride, n0, n1, ctx); break;
    case IMX_UNIS: unis_process((ImxUnison *)s, data, stride, n0, n1, ctx); break;
    case IMX_VERB: verb_process((ImxVerb *)s, data, stride, n0, n1, ctx); break;
    case IMX_DLAY: delay_process((ImxDelay *)s, data, stride, n0, n1, ctx); break;
    case IMX_LIMI: limi_process((ImxLimiter *)s, data, stride, n0, n1, ctx); break;
    default: mx_process((ImxMixTool *)s, data, stride, n0, n1, ctx); break;
    }
}

/* Only the unison and the delay keep time while the chain idles. */
static void stage_skip(TaudImxChain *c, int k, int frames)
{
    if (k == IMX_UNIS) unis_skip((ImxUnison *)c->stage[k], frames, &c->ctx);
    else if (k == IMX_DLAY) delay_skip((ImxDelay *)c->stage[k], frames);
}

TaudImxChain *te_imx_chain_new(const TaudImixBlock *block, int rate, int nch, bool stereo, bool ambisonic)
{
    TaudImxChain *c = (TaudImxChain *)calloc(1, sizeof *c);
    if (c == NULL) return NULL;
    c->rate = rate;
    c->nch = nch;
    c->stereo = stereo;
    c->ambisonic = ambisonic && !stereo && nch > 1;
    c->dryBuf = (double *)calloc((size_t)nch * TRACKER_CHUNK, sizeof(double));
    if (c->dryBuf == NULL) { free(c); return NULL; }
    c->idle = true;
    c->ctx.nch = nch;
    c->ctx.stereo = stereo;
    c->ctx.ambisonic = c->ambisonic;
    c->ctx.bpm = 125;
    c->ctx.dryBuf = c->dryBuf;
    te_imx_chain_set_block(c, block);
    if (c->oom) { te_imx_chain_free(c); return NULL; }
    return c;
}

void te_imx_chain_free(TaudImxChain *c)
{
    int k;
    if (c == NULL) return;
    for (k = 0; k < IMX_KINDS; k++) free_stage(k, c->stage[k]);
    free(c->dryBuf);
    free(c);
}

/* Install a block's settings (setBlock). Delay lines and envelopes are kept;
 * a piece coming (back) into the chain starts clean. */
void te_imx_chain_set_block(TaudImxChain *c, const TaudImixBlock *b)
{
    const int *order = PIPELINES[b->order == 1 ? 1 : 0];
    bool was[IMX_KINDS];
    int i, memory = 0;
    memset(was, 0, sizeof was);
    for (i = 0; i < c->nActive; i++) was[c->active[i]] = true;
    c->nActive = 0;
    for (i = 0; i < IMX_KINDS; i++) {
        int k = order[i];
        const TaudImxEquipment *e = &b->eq[k];
        if (!e->present || e->bypass) continue;     /* bypassed equipment is not processed at all */
        if (c->stage[k] == NULL) {
            c->stage[k] = make_stage(c, k);
            if (c->stage[k] == NULL) { c->oom = true; continue; }
        }
        stage_configure(c, k, e);
        if (!was[k]) stage_reset(k, c->stage[k]);
        c->active[c->nActive] = k;
        c->activeDry[c->nActive] = wet_applicable(k) ? e->dry / 255.0 : 0;
        c->nActive++;
        memory += stage_memory(k, c->stage[k]);
    }
    c->idleAfter = memory + (int)js_round(IMX_IDLE_MARGIN_SEC * c->rate);
}

/* Clear every delay line, envelope and phase (a transport reset). */
void te_imx_chain_reset(TaudImxChain *c)
{
    int k;
    for (k = 0; k < IMX_KINDS; k++) if (c->stage[k] != NULL) stage_reset(k, c->stage[k]);
    c->idle = true;
    c->silentRun = 0;
}

/* A note of an instrument on this bus has started: phase-reset its
 * retriggering LFOs. */
void te_imx_chain_note_on(TaudImxChain *c)
{
    ImxUnison *u = (ImxUnison *)c->stage[IMX_UNIS];
    if (u != NULL && u->hasP) unis_retrigger(u);
}

bool te_imx_chain_idle(const TaudImxChain *c) { return c->idle; }

static int first_signal(const double *data, int nch, int stride, int n0, int n1)
{
    int n, c;
    for (n = n0; n < n1; n++) for (c = 0; c < nch; c++) if (data[c * stride + n] != 0) return n;
    return -1;
}

/* Run [n0, n1) of the bus in place. `fed`: did any voice write into this
 * span — a chain that is idle and was not fed only keeps its LFOs in time. */
void te_imx_chain_process(TaudImxChain *c, double *data, int stride, int n0, int n1, int bpm, bool fed)
{
    int nch = c->nch, frames = n1 - n0, i, n, ch, lastIn = -1;
    c->ctx.bpm = bpm;
    if (c->idle) {
        /* Wake on the first non-zero SAMPLE, not at the top of the span. */
        int m = fed ? first_signal(data, nch, stride, n0, n1) : -1;
        if (m < 0) {
            for (i = 0; i < c->nActive; i++) stage_skip(c, c->active[i], frames);
            return;
        }
        if (m > n0) for (i = 0; i < c->nActive; i++) stage_skip(c, c->active[i], m - n0);
        n0 = m;
        c->idle = false;
        c->silentRun = 0;
    }
    /* The last non-zero input sample of the span: the idle rule needs it. */
    for (n = n1 - 1; n >= n0 && lastIn < 0; n--) {
        for (ch = 0; ch < nch; ch++) if (data[ch * stride + n] != 0) { lastIn = n; break; }
    }
    for (i = 0; i < c->nActive; i++) {
        if (c->probe[0] != NULL) te_imix_tap_stage_in(c->probe[0], c->active[i], n0, n1);
        if (c->probe[1] != NULL) te_imix_tap_stage_in(c->probe[1], c->active[i], n0, n1);
        c->ctx.dry = c->activeDry[i];
        stage_process(c, c->active[i], data, stride, n0, n1);
    }
    /* Idle rule: the trailing run of samples that had no input AND left the
     * chain below the idle level, counted sample by sample. */
    for (n = n0; n < n1; n++) {
        bool quiet = n > lastIn;
        if (quiet) {
            for (ch = 0; ch < nch; ch++) {
                double y = data[ch * stride + n];
                if (y >= IMX_IDLE_LEVEL || y <= -IMX_IDLE_LEVEL) { quiet = false; break; }
            }
        }
        if (!quiet) { c->silentRun = 0; continue; }
        if (++c->silentRun >= c->idleAfter) {
            /* Idle from the NEXT sample: what a cleared chain fed silence makes. */
            int m, remain = n1 - (n + 1), k;
            for (m = n + 1; m < n1; m++) for (ch = 0; ch < nch; ch++) data[ch * stride + m] = 0;
            for (k = 0; k < IMX_KINDS; k++) if (c->stage[k] != NULL) stage_reset(k, c->stage[k]);
            if (remain > 0) for (i = 0; i < c->nActive; i++) stage_skip(c, c->active[i], remain);
            c->idle = true;
            c->silentRun = 0;
            break;
        }
    }
}

/* ── buses and routing (InstrumentBus, syncImixRoutes) ───────────────────── */

/* Which render target the master bus is built on: none (the stereo model),
 * the binaural renderer (kept across re-applications, as the JS keeps its
 * object), or a fold renderer, which every application makes afresh. */
static uintptr_t current_renderer(const TaudEngine *e)
{
    if (e->spatial == NULL) return 0;
    if (e->spatial->kind == 1) return (uintptr_t)e->spatial->bin;
    return ((uintptr_t)e->rendererGen << 1) | 1;
}

static void bus_free(TaudImixBus *bus)
{
    if (bus == NULL) return;
    te_imx_chain_free(bus->chain);
    free(bus->slots);
    free(bus);
}

static bool bus_add_slot(TaudImixBus *bus, int slot)
{
    if (bus->nSlots == bus->capSlots) {
        int nc = bus->capSlots == 0 ? 4 : bus->capSlots * 2;
        int *ns = (int *)realloc(bus->slots, sizeof(int) * (size_t)nc);
        if (ns == NULL) return false;
        bus->slots = ns;
        bus->capSlots = nc;
    }
    bus->slots[bus->nSlots++] = slot;
    return true;
}

static TaudImixBus *bus_new(TaudEngine *e, int slot, const TaudImixBlock *block)
{
    TaudImixBus *bus = (TaudImixBus *)calloc(1, sizeof *bus);
    bool scene;
    if (bus == NULL) return NULL;
    bus->slot = slot;
    bus->blockId = block->id;
    bus->renderer = current_renderer(e);
    if (e->spatial == NULL) {
        bus->nch = 2;
        bus->stereo = true;
        scene = false;
    } else {
        bus->sb.kind = e->spatial->kind;
        bus->sb.bin = e->spatial->bin;
        bus->nch = e->spatial->numChannels;
        /* The device renders a surround song through a stereo fold: its two
         * channels ARE a left/right pair. */
        bus->stereo = bus->nch == 2 && e->spatial->kind == 0;
        scene = e->spatial->kind == 1;
    }
    bus->sb.numChannels = bus->nch;
    bus->chain = te_imx_chain_new(block, e->rate, bus->nch, bus->stereo, scene);
    if (bus->chain == NULL) { free(bus); return NULL; }
    return bus;
}

void te_imix_free_routes(TaudEngine *e)
{
    int i;
    for (i = 0; i < e->imixCount; i++) bus_free(e->imixList[i]);
    free(e->imixList);
    e->imixList = NULL;
    e->imixCount = e->imixCap = 0;
    memset(e->imixRoutes, 0, sizeof e->imixRoutes);
}

/* Rebuild the route table from the blocks and the instruments. A slot gets a
 * bus when its record names a block that exists and is engaged; in bus mode
 * the first slot naming the block makes the bus and every later one joins it.
 * A bus that survives — same first slot, same render target — keeps its
 * chain and is only re-set. */
void te_sync_imix_routes(TaudEngine *e)
{
    TaudImixBus **old = e->imixList;
    int oldCount = e->imixCount, i, slot;
    TaudImixBus *oldBySlot[1024];
    TaudImixBus *shared[256];
    uintptr_t renderer = current_renderer(e);
    int nch = e->spatial == NULL ? 2 : e->spatial->numChannels;
    e->imixSyncedGen = e->imixGen;
    e->imixRenderer = renderer;
    memset(oldBySlot, 0, sizeof oldBySlot);
    memset(shared, 0, sizeof shared);
    for (i = 0; i < oldCount; i++) oldBySlot[old[i]->slot] = old[i];
    e->imixList = NULL;
    e->imixCount = e->imixCap = 0;
    memset(e->imixRoutes, 0, sizeof e->imixRoutes);
    for (slot = 1; slot < 1024; slot++) {
        int id = inst_imix_id(&e->instruments[slot]);
        const TaudImixBlock *block;
        TaudImixBus *bus;
        if (id == 0) continue;
        block = e->imixBlocks[id];
        if (block == NULL || !te_imix_block_engaged(block)) continue;
        if (block->bus && shared[id] != NULL) {
            if (!bus_add_slot(shared[id], slot)) e->oom = true;
            continue;
        }
        bus = oldBySlot[slot];
        if (bus != NULL && bus->renderer == renderer && bus->nch == nch) {
            oldBySlot[slot] = NULL;
            bus->blockId = id;
            te_imx_chain_set_block(bus->chain, block);
        } else {
            bus = bus_new(e, slot, block);
            if (bus == NULL) { e->oom = true; continue; }
        }
        bus->nSlots = 0;
        if (!bus_add_slot(bus, slot)) e->oom = true;
        if (block->bus) shared[id] = bus;
        if (e->imixCount == e->imixCap) {
            int nc = e->imixCap == 0 ? 8 : e->imixCap * 2;
            TaudImixBus **nl = (TaudImixBus **)realloc(e->imixList, sizeof *nl * (size_t)nc);
            if (nl == NULL) { bus_free(bus); e->oom = true; continue; }
            e->imixList = nl;
            e->imixCap = nc;
        }
        /* Made in ascending slot order: the order the buses join the mix. */
        e->imixList[e->imixCount++] = bus;
    }
    for (i = 0; i < e->imixCount; i++) {
        TaudImixBus *bus = e->imixList[i];
        int k;
        for (k = 0; k < bus->nSlots; k++) e->imixRoutes[bus->slots[k]] = bus;
    }
    for (slot = 0; slot < 1024; slot++) bus_free(oldBySlot[slot]);
    free(old);
}

/* The project's blocks (setImix): replaces the whole set. */
void te_set_imix(TaudEngine *e, const TaudImixBlock *blocks, int count)
{
    int i;
    memset((void *)e->imixBlocks, 0, sizeof e->imixBlocks);
    for (i = 0; i < count; i++) e->imixBlocks[blocks[i].id & 0xff] = &blocks[i];
    e->imixGen++;
}

/* Every chain's running state goes with a transport reset; so do the note
 * flags. */
void te_imix_reset_chains(TaudEngine *e)
{
    int i;
    for (i = 0; i < e->imixCount; i++) te_imx_chain_reset(e->imixList[i]->chain);
    memset(e->imixTrig, 0, sizeof e->imixTrig);
}

/* ── readings for the Mixing tab's meters ── */

void te_imx_chain_set_probes(TaudImxChain *c, struct TaudImixTap *a, struct TaudImixTap *b)
{
    c->probe[0] = a;
    c->probe[1] = b;
}

/* The chain's gain reductions over the span it last processed (readGr): each
 * compressor band's (dB, ≤ 0), each dynamic-EQ and transient-shaper band's
 * dynamic gain (signed), the expander's and the limiter's (≤ 0), and the
 * loudest detector reading of the expander and of every comp and dynamic-EQ
 * band (dB, −120 = nothing). A piece out of the chain reads at rest. */
void te_imx_chain_read_gr(const TaudImxChain *c, TaudImxGr *out)
{
    int i, k;
    memset(out, 0, sizeof *out);
    out->expdLvl = -120;
    for (k = 0; k < IMX_COMP_MAX_BANDS; k++) out->compLvl[k] = -120;
    for (k = 0; k < IMX_DEQ_BANDS; k++) out->deq1Lvl[k] = out->deq2Lvl[k] = -120;
    for (i = 0; i < c->nActive; i++) {
        int id = c->active[i];
        const void *st = c->stage[id];
        if (st == NULL) continue;
        if (id == IMX_EXPD) {
            out->expd = ((const ImxExpander *)st)->gr;
            out->expdLvl = ((const ImxExpander *)st)->lvl;
        } else if (id == IMX_COMP) {
            const ImxComp *s = (const ImxComp *)st;
            for (k = 0; k < IMX_COMP_MAX_BANDS; k++) {
                out->comp[k] = s->gr[k];
                out->compLvl[k] = s->lvlInit ? s->lvl[k] : -120;
            }
        } else if (id == IMX_TSH1) {
            for (k = 0; k < IMX_TSH_MAX_BANDS; k++) out->tsh1[k] = ((const ImxTransient *)st)->gr[k];
        } else if (id == IMX_DEQ1 || id == IMX_DEQ2) {
            const ImxDeq *s = (const ImxDeq *)st;
            double *gr = id == IMX_DEQ1 ? out->deq1 : out->deq2;
            double *lvl = id == IMX_DEQ1 ? out->deq1Lvl : out->deq2Lvl;
            for (k = 0; k < IMX_DEQ_BANDS; k++) { gr[k] = s->gr[k]; lvl[k] = s->lvl[k]; }
        } else if (id == IMX_LIMI) {
            out->lim = ((const ImxLimiter *)st)->stage.grDb;
        }
    }
}

/* The unison's live detune (cents) and width while it is in the chain. */
bool te_imx_chain_unison_now(const TaudImxChain *c, double *cents, double *width)
{
    int i;
    for (i = 0; i < c->nActive; i++) {
        if (c->active[i] == IMX_UNIS && c->stage[IMX_UNIS] != NULL) {
            const ImxUnison *s = (const ImxUnison *)c->stage[IMX_UNIS];
            *cents = s->curCents;
            *width = s->curWidth;
            return true;
        }
    }
    return false;
}
