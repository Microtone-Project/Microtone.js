/* TaudEngine — the device facade (engine.js) plus the Playhead/TrackerState
 * parts of state.js that a player drives, and the rng.js seams. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

/* ── randomness (rng.js) ── */

static double mulberry32(void *user)
{
    uint32_t *a = (uint32_t *)user, t;
    *a += 0x6d2b79f5u;
    t = *a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return (double)(t ^ (t >> 14)) / 4294967296.0;
}

double te_random(TaudEngine *e)
{
    if (e->random != NULL) return e->random(e->randomUser);
    return mulberry32(&e->mulberry);
}

/* ── voices ── */

static const TaudEnvPoint DEFAULT_ENV_3F[ENV_POINTS] = {
    {0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},
    {0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},
    {0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0},{0x3f,0}
};
static const TaudEnvPoint DEFAULT_ENV_80[ENV_POINTS] = {
    {0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},
    {0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0},
    {0x80,0},{0x80,0},{0x80,0},{0x80,0},{0x80,0}
};

/* A fresh Voice, exactly as `new Voice()` leaves one (voice.js). */
void te_voice_init(TaudVoice *v)
{
    bool pooled = v->pooled;
    TaudVoice *nextFree = v->nextFree;
    memset(v, 0, sizeof *v);
    v->pooled = pooled;
    v->nextFree = nextFree;

    v->playbackRate = 1.0;
    v->currentPlaybackRate = 1.0;
    v->snapPlaybackRate = true;
    v->forward = true;
    v->sourceChannel = -1;
    v->activePatchIndex = -1;
    v->layerFixedNote = -1;
    v->layerMixGain = 1.0;
    v->nnaOverride = -1;
    v->volEnvOn = v->panEnvOn = v->pitchEnvOn = v->filterEnvOn = true;
    v->noteVolume = 0x3f;
    v->channelVolume = 0x3f;
    v->rowVolume = 63;
    v->channelPan = 0x80;
    v->rowPan = 32;
    v->panAzimuth = 128.0;
    v->spatialTargetAz = 128.0;
    v->currentMixVolume = 1.0;
    v->currentPan = 128.0;
    v->snapPan = true;
    v->envVolume = 1.0;
    v->envVolMix = 1.0;
    v->envPan = 0.5;
    v->envPitchValue = 0.5;
    v->envFilterValue = 0.5;
    v->fadeoutVolume = 1.0;
    v->fadeoutMix = 1.0;
    v->faderCur = NAN;
    v->elevCur = NAN;
    v->sfCents = NAN;
    v->activeChanCount = 1;
    v->right.nesDpcmCounter = 63;
    v->activeVolEnv = DEFAULT_ENV_3F;
    v->activeVolEnvMax = 63;
    v->activePanEnv = DEFAULT_ENV_80;
    v->activePitchEnv = DEFAULT_ENV_80;
    v->activeFilterEnv = DEFAULT_ENV_80;
    v->activeDefaultCutoff = 0xff;
    v->activeDefaultResonance = 0xff;
    v->activeAttenGain = 1.0;
    v->nesDpcmCounter = 63;
    v->currentCutoff = 0xff;
    v->currentResonance = 0xff;
    v->filterA0 = 1.0;
    v->filterCutoffCached = -1;
    v->filterResonanceCached = -1;
    v->basePitch = 0x4000;
    v->amigaPeriod = -1.0;
    v->linearFreq = -1.0;
    v->tonePortaTarget = -1;
    v->tremorOnTime = 1;
    v->tremorOffTime = 1;
    v->tremorPhaseOn = true;
    v->vibratoRetrig = true;
    v->vibratoFineShift = 6;
    v->tremoloRetrig = true;
    v->panbrelloRetrig = true;
    v->noteDelayTick = -1;
    v->delayedVol = -1;
    v->delayedGlide = false;
    v->noteActionTick = -1;
    v->delayedAction = -1;
    v->cutAtTick = -1;
    v->funkWalk = -1;
    v->funkPos = -1;
    v->funkWindow = -1;
    v->funkXfadeLen = 1;
    v->modGeom.epoch = -1;
    v->modGeom.base = -1;
    v->modGeom.len = -1;
    v->modFunkWindow = -1;
    v->modFunkXfadeLen = 1;
    v->panLawPan = NAN;
}

/* Background voices come from a pool. A voice leaves the background list
 * long before nothing refers to it any more — an FM rack keeps reading an
 * operator the list has dropped — so slots are reclaimed by marking what the
 * lanes and the list can still reach, exactly the objects the JS keeps alive. */

#define POOL_CHUNK 64

static void mark_voice(TaudVoice *v)
{
    /* Reachability is at most three hops (voice → rig → operator → parent),
     * so plain recursion is bounded. */
    int k;
    if (v == NULL || v->marked) return;
    v->marked = true;
    if (v->fmRig != NULL) for (k = 0; k < v->fmRig->count; k++) mark_voice(v->fmRig->voices[k]);
    mark_voice(v->fmParent);
}

static void pool_collect(TaudEngine *e)
{
    TaudVoiceChunk *c;
    int i;
    for (c = e->chunks; c != NULL; c = c->next) for (i = 0; i < c->count; i++) c->voices[i].marked = false;
    for (i = 0; i < TOTAL_VOICES; i++) e->voices[i].marked = false;
    for (i = 0; i < TOTAL_VOICES; i++) mark_voice(&e->voices[i]);
    for (i = 0; i < e->bgCount; i++) mark_voice(e->bg[i]);
    e->freeList = NULL;
    for (c = e->chunks; c != NULL; c = c->next) {
        for (i = 0; i < c->count; i++) {
            TaudVoice *v = &c->voices[i];
            if (!v->marked) { v->nextFree = e->freeList; e->freeList = v; }
        }
    }
}

static bool pool_grow(TaudEngine *e, int count)
{
    TaudVoiceChunk *c = (TaudVoiceChunk *)calloc(1, sizeof *c + sizeof(TaudVoice) * (size_t)(count - 1));
    int i;
    if (c == NULL) return false;
    c->count = count;
    c->next = e->chunks;
    e->chunks = c;
    for (i = 0; i < count; i++) {
        c->voices[i].pooled = true;
        c->voices[i].nextFree = e->freeList;
        e->freeList = &c->voices[i];
    }
    e->poolSize += count;
    return true;
}

TaudVoice *te_voice_alloc(TaudEngine *e)
{
    TaudVoice *v;
    if (e->freeList == NULL) {
        pool_collect(e);
        if (e->freeList == NULL && !pool_grow(e, POOL_CHUNK)) { e->oom = true; return NULL; }
    }
    v = e->freeList;
    e->freeList = v->nextFree;
    te_voice_init(v);
    return v;
}

void te_bg_push(TaudEngine *e, TaudVoice *v)
{
    if (e->bgCount == e->bgCap) {
        int nc = e->bgCap ? e->bgCap * 2 : 128;
        TaudVoice **nb = (TaudVoice **)realloc(e->bg, sizeof *nb * (size_t)nc);
        if (nb == NULL) { e->oom = true; return; }
        e->bg = nb;
        e->bgCap = nc;
    }
    e->bg[e->bgCount++] = v;
}

void te_bg_remove_at(TaudEngine *e, int i)
{
    memmove(&e->bg[i], &e->bg[i + 1], sizeof *e->bg * (size_t)(e->bgCount - i - 1));
    e->bgCount--;
}

/* ── retired instrument data ──
 *
 * A host re-uploads an instrument while its notes are sounding: the record's
 * decoded objects (a metainstrument's table, a chip patch, the Ixmp patches a
 * voice's envelopes point into, a lyric instrument's syllables) are replaced
 * under voices that go on reading the old ones. The JavaScript engine has a
 * garbage collector for exactly this; here the replaced block is RETIRED and
 * freed once nothing can reach it.
 *
 * "Can reach" is decided conservatively, as a collector without type
 * information decides it: a block is live while any pointer-sized word of a
 * voice — every lane and jam voice, sounding or not, every background voice
 * and whatever those reach through an FM rack — holds an address inside it,
 * or while a live retired block does. An integer that happens to look like an
 * address only delays a free. */

struct TaudRetired { void *ptr; size_t size; bool live; };

#define RETIRE_SWEEP_COUNT 64
#define RETIRE_SWEEP_BYTES ((size_t)1 << 20)

void te_retire(TaudEngine *e, void *p, size_t size)
{
    if (p == NULL) return;
    if (e == NULL) { free(p); return; }
    if (e->retiredCount == e->retiredCap) {
        int nc = e->retiredCap ? e->retiredCap * 2 : 64;
        struct TaudRetired *nl = (struct TaudRetired *)realloc(e->retired, sizeof *nl * (size_t)nc);
        /* Out of memory for the list itself: the block is leaked rather than
         * freed under a voice. */
        if (nl == NULL) { e->oom = true; return; }
        e->retired = nl;
        e->retiredCap = nc;
    }
    e->retired[e->retiredCount].ptr = p;
    e->retired[e->retiredCount].size = size > 0 ? size : 1;
    e->retired[e->retiredCount].live = false;
    e->retiredCount++;
    e->retiredBytes += size;
    if (e->retiredCount >= e->retireSweepAt || e->retiredBytes >= RETIRE_SWEEP_BYTES) te_retire_sweep(e);
}

/* Mark every retired block some word of [base, base + size) points into;
 * returns how many were newly marked. */
static int retire_scan(TaudEngine *e, const void *base, size_t size, uintptr_t lo, uintptr_t hi)
{
    const unsigned char *b = (const unsigned char *)base;
    size_t n = size / sizeof(uintptr_t), i;
    int marked = 0, k;
    for (i = 0; i < n; i++) {
        uintptr_t w;
        memcpy(&w, b + i * sizeof w, sizeof w);
        if (w < lo || w >= hi) continue;
        for (k = 0; k < e->retiredCount; k++) {
            struct TaudRetired *r = &e->retired[k];
            if (!r->live && w >= (uintptr_t)r->ptr && w < (uintptr_t)r->ptr + r->size) { r->live = true; marked++; }
        }
    }
    return marked;
}

void te_retire_sweep(TaudEngine *e)
{
    uintptr_t lo = UINTPTR_MAX, hi = 0;
    TaudVoiceChunk *c;
    int i, k, kept = 0;
    size_t bytes = 0;
    bool again;
    if (e->retiredCount == 0) return;
    for (k = 0; k < e->retiredCount; k++) {
        uintptr_t a = (uintptr_t)e->retired[k].ptr;
        if (a < lo) lo = a;
        if (a + e->retired[k].size > hi) hi = a + e->retired[k].size;
        e->retired[k].live = false;
    }
    /* Roots: the lanes and the jam bank, then every pooled voice the lanes
     * and the background list can still reach (pool_collect's marking). */
    for (i = 0; i < TOTAL_VOICES; i++) retire_scan(e, &e->voices[i], sizeof(TaudVoice), lo, hi);
    for (c = e->chunks; c != NULL; c = c->next) for (i = 0; i < c->count; i++) c->voices[i].marked = false;
    for (i = 0; i < TOTAL_VOICES; i++) e->voices[i].marked = false;
    for (i = 0; i < TOTAL_VOICES; i++) mark_voice(&e->voices[i]);
    for (i = 0; i < e->bgCount; i++) mark_voice(e->bg[i]);
    for (c = e->chunks; c != NULL; c = c->next) {
        for (i = 0; i < c->count; i++) {
            if (c->voices[i].marked) retire_scan(e, &c->voices[i], sizeof(TaudVoice), lo, hi);
        }
    }
    /* …and what a live block itself points at (a syllable patch names the
     * patch it was made from). */
    do {
        again = false;
        for (k = 0; k < e->retiredCount; k++) {
            struct TaudRetired *r = &e->retired[k];
            if (r->live && retire_scan(e, r->ptr, r->size, lo, hi) > 0) again = true;
        }
    } while (again);
    for (k = 0; k < e->retiredCount; k++) {
        struct TaudRetired *r = &e->retired[k];
        if (r->live) { bytes += r->size; e->retired[kept++] = *r; }
        else free(r->ptr);
    }
    e->retiredCount = kept;
    e->retiredBytes = bytes;
    /* What stayed is held by voices; look again only once as much has been
     * retired on top of it. */
    e->retireSweepAt = kept * 2 > RETIRE_SWEEP_COUNT ? kept * 2 : RETIRE_SWEEP_COUNT;
}

/* ── patterns and cues ── */

const TaudCell *te_pattern_read(const TaudEngine *e, int idx)
{
    if (idx < 0 || idx >= NUM_PATTERNS || e->playdata[idx] == NULL) return e->emptyPattern;
    return e->playdata[idx];
}

static bool is_shared_blank(const TaudEngine *e, const TaudCell *p)
{
    return p != NULL && (p == e->sharedBlank[0] || p == e->sharedBlank[1]);
}

static TaudCell *new_pattern(TaudEngine *e)
{
    TaudCell *p = (TaudCell *)calloc(ROWS_PER_PATTERN, sizeof *p);
    int i;
    if (p == NULL) { e->oom = true; return NULL; }
    for (i = 0; i < ROWS_PER_PATTERN; i++) p[i].pan = 32;
    return p;
}

/* Writable pattern idx, allocating its rows on first access — and copying
 * the shared blank before anything is written over it. */
static TaudCell *pattern_for(TaudEngine *e, int idx)
{
    TaudCell *p;
    if (idx < 0 || idx >= NUM_PATTERNS) return NULL;
    p = e->playdata[idx];
    if (p == NULL) {
        p = new_pattern(e);
        if (p == NULL) return NULL;
        e->playdata[idx] = p;
    } else if (is_shared_blank(e, p)) {
        TaudCell *q = (TaudCell *)malloc(sizeof *q * ROWS_PER_PATTERN);
        if (q == NULL) { e->oom = true; return NULL; }
        memcpy(q, p, sizeof *q * ROWS_PER_PATTERN);
        e->playdata[idx] = p = q;
    }
    return p;
}

static void cell_set_byte(TaudCell *c, int o, int b)
{
    switch (o) {
    /* The 8-byte cell has no room for a fraction: writing a note byte drops
     * whatever sixteenths the cell carried (TaudPlayData.setByte's `&`). */
    case 0: c->note = (c->note & 0xff00) | b; c->noteFrac = 0; break;
    case 1: c->note = (c->note & 0x00ff) | (b << 8); c->noteFrac = 0; break;
    case 2: c->instrment = b; break;
    case 3: c->volume = b & 63; c->volumeEff = (b >> 6) & 3; break;
    case 4: c->pan = b & 63; c->panEff = (b >> 6) & 3; break;
    case 5: c->effect = b; break;
    case 6: c->effectArg = (c->effectArg & 0xff00) | b; break;
    case 7: c->effectArg = (c->effectArg & 0x00ff) | (b << 8); break;
    default: break;
    }
}

static void cell_set_byte_wide(TaudCell *c, int o, int b)
{
    switch (o) {
    /* _setWideNote: the word takes the fine nibble last decoded — none under
     * a sentinel (§5.5: the nibble is RESERVED there). */
    case 0: c->note = (c->note & 0xff00) | b; c->noteFrac = c->note >= 0x20 ? c->noteFine : 0; break;
    case 1: c->note = (c->note & 0x00ff) | (b << 8); c->noteFrac = c->note >= 0x20 ? c->noteFine : 0; break;
    case 2: c->instrment = b; break;
    case 3: c->volume = b & 0xff; break;
    case 4: c->azimuth = (c->azimuth & 0x100) | b; break;
    case 5: c->effect = b; break;
    case 6: c->effectArg = (c->effectArg & 0xff00) | b; break;
    case 7: c->effectArg = (c->effectArg & 0x00ff) | (b << 8); break;
    case 8:
        c->azimuth = (c->azimuth & 0xff) | ((b & 0x80) << 1);
        c->volumeEff = (b >> 4) & 7;
        c->panEff = b & 0xf;
        break;
    case 9: c->elevation = (int8_t)(b >= 0x80 ? b - 0x100 : b); break;
    case 10: c->effect2 = b; break;
    case 11: c->effectArg2 = (c->effectArg2 & 0xff00) | b; break;
    case 12: c->effectArg2 = (c->effectArg2 & 0x00ff) | (b << 8); break;
    case 13: /* low nibble RESERVED */
        c->noteFine = (uint8_t)(b >> 4);
        c->noteFrac = c->note >= 0x20 ? c->noteFine : 0;
        break;
    default: break;
    }
}

static void decode_pattern(const TaudEngine *e, TaudCell *pat, const uint8_t *bytes, size_t len)
{
    size_t i, n;
    if (e->wideCells) {
        n = len < PATTERN_BYTES_WIDE ? len : PATTERN_BYTES_WIDE;
        for (i = 0; i < n; i++) cell_set_byte_wide(&pat[i / CELL_BYTES_WIDE], (int)(i % CELL_BYTES_WIDE), bytes[i]);
        return;
    }
    n = len < PATTERN_BYTES ? len : PATTERN_BYTES;
    for (i = 0; i < n; i++) cell_set_byte(&pat[i / CELL_BYTES], (int)(i % CELL_BYTES), bytes[i]);
}

/* The no-op cell's bytes: both column selectors FINE by zero, everything else
 * zero (file format §5.5). */
static bool is_blank_pattern_bytes(const uint8_t *bytes, size_t len, bool wide)
{
    int size = wide ? CELL_BYTES_WIDE : CELL_BYTES;
    size_t i;
    if (len < (size_t)(64 * size)) return false;
    for (i = 0; i < (size_t)(64 * size); i++) {
        int k = (int)(i % size);
        int want = wide ? (k == 8 ? 0x33 : 0) : (k == 3 || k == 4 ? 0xc0 : 0);
        if (bytes[i] != want) return false;
    }
    return true;
}

/* The one copy every slot holding a blank pattern shares, one per cell
 * format (blankPattern). Read-only: pattern_for copies it before a write. */
static TaudCell *blank_pattern(TaudEngine *e)
{
    int k = e->wideCells ? 1 : 0;
    if (e->sharedBlank[k] == NULL) {
        uint8_t bytes[PATTERN_BYTES_WIDE];
        int size = e->wideCells ? CELL_BYTES_WIDE : CELL_BYTES, r;
        TaudCell *p = new_pattern(e);
        if (p == NULL) return NULL;
        memset(bytes, 0, sizeof bytes);
        for (r = 0; r < 64; r++) {
            if (e->wideCells) bytes[r * size + 8] = 0x33;
            else { bytes[r * size + 3] = 0xc0; bytes[r * size + 4] = 0xc0; }
        }
        decode_pattern(e, p, bytes, (size_t)(64 * size));
        e->sharedBlank[k] = p;
    }
    return e->sharedBlank[k];
}

/* A blank pattern is not stored but shared: a song renumbered lane by lane
 * leaves thousands of them in the gaps between lanes. */
void te_upload_pattern(TaudEngine *e, int slot, const uint8_t *bytes, size_t len)
{
    int idx = slot & 0x7fff;
    TaudCell *pat;
    if (idx < NUM_PATTERNS && is_blank_pattern_bytes(bytes, len, e->wideCells)) {
        TaudCell *b = blank_pattern(e);
        if (b != NULL) {
            if (!is_shared_blank(e, e->playdata[idx])) free(e->playdata[idx]);
            e->playdata[idx] = b;
            return;
        }
    }
    pat = pattern_for(e, idx);
    if (pat == NULL) return;
    decode_pattern(e, pat, bytes, len);
}

/* Deallocate a pattern slot: it reads as the empty pattern again, exactly as
 * a slot that was never written (clearPattern). */
void te_clear_pattern(TaudEngine *e, int slot)
{
    int idx = slot & 0x7fff;
    if (idx >= NUM_PATTERNS) return;
    if (!is_shared_blank(e, e->playdata[idx])) free(e->playdata[idx]);
    e->playdata[idx] = NULL;
}

static TaudPlayInst decode_inst_word(int w)
{
    TaudPlayInst r = { INST_NOP, 0, 0 };
    int b30, b31;
    if (w == 0) return r;
    b30 = (w >> 8) & 0xff;
    b31 = w & 0xff;
    if (b30 == 0x02) { r.type = INST_PATLEN; r.arg = r.rows = (b31 & 0x3f) + 1; return r; }
    if (b30 == 0x01) {
        if ((b31 & 0xc0) == 0x40) {
            int x = b31 & 0x3f;
            r.type = INST_HALTAT;
            r.arg = r.rows = x == 0 ? 64 : x;
            return r;
        }
        r.type = INST_HALT;
        return r;
    }
    if ((b30 & 0xf0) == 0x80) { r.type = INST_GOBACK; r.arg = ((b30 & 0xf) << 8) | b31; return r; }
    if ((b30 & 0xf0) == 0x90) { r.type = INST_SKIP; r.arg = ((b30 & 0xf) << 8) | b31; return r; }
    if ((b30 & 0xf0) == 0xf0) { r.type = INST_JUMP; r.arg = ((b30 & 0xf) << 8) | b31; return r; }
    return r;
}

static int cue_inst_word(const TaudCue *c, int base)
{
    int w = 0, k;
    for (k = 0; k < 16; k++) w |= ((c->raw[base + k] >> 15) & 1) << k;
    return w;
}

static void cue_init(TaudCue *c)
{
    int i;
    for (i = 0; i < MAX_VOICES; i++) c->raw[i] = PATTERN_EMPTY;
    c->inst0.type = c->inst1.type = INST_NOP;
    c->inst0.arg = c->inst1.arg = 0;
    c->inst0.rows = c->inst1.rows = 0;
}

const TaudCue *te_cue_at(const TaudEngine *e, int idx)
{
    const TaudCue *block;
    idx &= NUM_CUES - 1;
    block = e->cueBlocks[idx / CUE_BLOCK];
    return block != NULL ? &block[idx % CUE_BLOCK] : &e->emptyCue;
}

void te_upload_cue(TaudEngine *e, int idx, const uint8_t *bytes, size_t len)
{
    TaudCue *block, *cue;
    size_t n = e->is64ChannelMode ? 128 : 64, i;
    idx &= NUM_CUES - 1;
    block = e->cueBlocks[idx / CUE_BLOCK];
    if (block == NULL) {
        int k;
        block = (TaudCue *)malloc(sizeof(TaudCue) * CUE_BLOCK);
        if (block == NULL) { e->oom = true; return; }
        for (k = 0; k < CUE_BLOCK; k++) cue_init(&block[k]);
        e->cueBlocks[idx / CUE_BLOCK] = block;
    }
    cue = &block[idx % CUE_BLOCK];
    if (len < n) n = len;
    for (i = 0; i < n; i++) {
        int ch = (int)(i >> 1);
        cue->raw[ch] = (i & 1) == 0 ? (uint16_t)((cue->raw[ch] & 0xff00) | bytes[i])
                                    : (uint16_t)((cue->raw[ch] & 0x00ff) | (bytes[i] << 8));
    }
    cue->inst0 = decode_inst_word(cue_inst_word(cue, 0));
    cue->inst1 = decode_inst_word(cue_inst_word(cue, 16));
}

/* ── content upload ── */

/* Install a sample+instrument image: `pool` is borrowed (the engine never
 * writes a sample), `instBin` holds the 1024 256-byte instrument records. */
void te_upload_sample_inst_blob(TaudEngine *e, const uint8_t *pool, size_t poolLen, const uint8_t *instBin)
{
    int i;
    e->sampleBin = pool;
    e->samplePoolLen = poolLen;
    for (i = 0; i < 1024; i++) te_inst_load_record(&e->instruments[i], instBin + (size_t)i * 256);
    /* A chip patch may have been freed and another allocated where it was. */
    e->formantTables.chipMemoCount = 0;
    e->hasPsg = false;
    for (i = 0; i < 1024; i++) if (e->instruments[i].psg != NULL) e->hasPsg = true;
    for (i = 0; i < NUM_INST_SLOTS; i++) {
        TaudInst *inst = &e->instruments[i];
        te_retire(e, inst->extraPatches, sizeof(TaudPatch) * (size_t)inst->patchCount);
        inst->extraPatches = NULL;
        inst->patchCount = 0;
    }
    e->imixGen++;   /* byte 255 of every record may have moved */
}

void te_upload_instrument_patches(TaudEngine *e, int slot, const uint8_t *bytes, size_t len)
{
    TaudInst *inst = &e->instruments[slot & 0x3ff];
    TaudPatch *patches = NULL;
    int n = te_parse_patches_blob(bytes, len, &patches);
    te_retire(e, inst->extraPatches, sizeof(TaudPatch) * (size_t)inst->patchCount);
    inst->extraPatches = n > 0 ? patches : NULL;
    inst->patchCount = n > 0 ? n : 0;
    if (n < 0) e->oom = true;
}

void te_set_cell_format(TaudEngine *e, bool wide)
{
    int i;
    e->wideCells = wide;
    if (e->ts_wideCells == wide) return;
    e->ts_wideCells = wide;
    e->volMax = wide ? VOLUME_MAX_WIDE : VOLUME_MAX;
    e->volStep = wide ? VOLUME_STEP_WIDE : 1;
    e->volDiv = e->volMax * 1.0;
    for (i = 0; i < TOTAL_VOICES; i++) {
        TaudVoice *v = &e->voices[i];
        v->noteVolume = e->volMax;
        v->channelVolume = e->volMax;
        v->channelVolumeSet = false;
        v->rowVolume = e->volMax;
    }
}

void te_set_tuning(TaudEngine *e, int baseNote, double freq)
{
    e->tuningBaseNote = baseNote & 0xffff;
    e->tuningFreq = freq;
    e->tuningRatio = te_tuning_ratio_of(e->tuningBaseNote, e->tuningFreq);
}

void te_update_global_behaviour(TaudEngine *e, int flags)
{
    e->toneMode = flags & 3;
    e->interpolationMode = (flags >> 2) & 7;
}

void te_set_tracker_mixer_flags(TaudEngine *e, int flags)
{
    e->initialGlobalFlags = flags;
    te_update_global_behaviour(e, flags);
}

/* (Re-)install the surround model with the monitor's render target. */
static void apply_surround_model(TaudEngine *e)
{
    int model = e->surroundModel & 3;
    e->ts_surroundModel = model;
    free(e->spatial);
    e->spatial = NULL;
    e->rendererGen++;
    /* The instrument buses are in the song's channel layout, which just moved. */
    e->imixGen++;
    if (model == SURROUND_STEREO) return;
    e->spatial = (TaudSpatialBus *)calloc(1, sizeof *e->spatial);
    if (e->spatial == NULL) { e->oom = true; e->ts_surroundModel = SURROUND_STEREO; return; }
    /* An exporter's render target stands in for the device's monitor. */
    if (e->rendererKind >= 0 &&
        te_spatial_bus_configure(e->spatial, e->rendererKind, e->rendererOrder, e->rendererPlanar, e->rendererLayout)) {
        return;
    }
    if (e->monitorMode == MONITOR_BINAURAL) {
        bool sphere = model == SURROUND_SPATIAL;
        if (e->binaural == NULL || e->binaural->sphere != sphere) {
            te_binaural_free(e->binaural);
            e->binaural = te_binaural_new(sphere, e->rate);
        }
        if (e->binaural != NULL) {
            te_binaural_reset(e->binaural);
            e->spatial->kind = 1;
            e->spatial->bin = e->binaural;
            e->spatial->numChannels = e->binaural->numChannels;
            return;
        }
        e->oom = true;
    }
    e->spatial->kind = 0;
    e->spatial->numChannels = 2;
}

void te_set_surround_model(TaudEngine *e, int model)
{
    e->surroundModel = model & 3;
    apply_surround_model(e);
}

void te_set_monitor_mode(TaudEngine *e, int mode)
{
    e->monitorMode = mode & 1;
    apply_surround_model(e);
}

/* Swap the render target the object bus feeds (setSpatialRenderer): −1 is the
 * device's own monitor again. No-op for a stereo song, which has no bus. */
void te_set_spatial_renderer(TaudEngine *e, int kind, int order, bool planar, int layout)
{
    e->rendererKind = kind;
    e->rendererOrder = order;
    e->rendererPlanar = planar;
    e->rendererLayout = layout;
    apply_surround_model(e);
}

void te_set_mastering(TaudEngine *e, const TaudMastering *params)
{
    if (params != NULL) { e->masteringParams = *params; e->hasMasteringParams = true; }
    else e->hasMasteringParams = false;
    if (!te_mastering_engaged(params)) {
        te_master_chain_free(e->mastering);
        e->mastering = NULL;
        return;
    }
    if (e->mastering == NULL) {
        e->mastering = te_master_chain_new(params, e->rate);
        if (e->mastering == NULL) e->oom = true;
    } else {
        te_master_chain_set_params(e->mastering, params);
    }
}

/* ── transport ── */

void te_set_cue_position(TaudEngine *e, int pos)
{
    e->position = pos & (NUM_CUES - 1);
    e->cuePos = e->position;
}

/* The per-PLAY half of every reset that starts playback somewhere (§15,
 * TrackerState.resetPlayState): the tick clock and the jump state, no voice
 * sounding, the background pool empty, the interrupt latch clear, the OPL
 * chip clock back at zero and the mastering chain's running state gone. */
void te_reset_play_state(TaudEngine *e)
{
    int i;
    e->tickInRow = 0;
    e->samplesIntoTick = 0.0;
    e->firstRow = true;
    e->oplFrame = 0;
    e->psgQuarter = 0;
    e->pendingOrderJump = -1;
    e->pendingRowJump = -1;
    e->pendingRowJumpLocal = false;
    e->patternDelayRemaining = 0;
    e->patternDelayActive = false;
    e->sexWinningChannel = -1;
    e->finePatternDelayExtra = 0;
    e->pendingInterrupts = 0;
    memset(e->interruptArgs, 0, sizeof e->interruptArgs);
    /* A play starts AT its levels: nothing glides in from the last one. */
    for (i = 0; i < TOTAL_VOICES; i++) { e->voices[i].active = false; e->voices[i].faderCur = NAN; }
    e->gvolGlide.cur = NAN;
    e->mvolGlide.cur = NAN;
    e->masterGlide.cur = NAN;
    e->bgCount = 0;
    if (e->mastering != NULL) te_master_chain_reset(e->mastering);
    /* …and the instruments' chains (item 217) for the same reason: a reverb
     * tail or a delay line still holding the previous take is that take. */
    te_imix_reset_chains(e);
    /* …and the Mixing tab's meters: their integration describes one playback. */
    for (i = 0; i < IMX_METER_SEATS; i++) if (e->imixMeters[i] != NULL) te_imix_tap_reset_all(e->imixMeters[i]);
}

void te_set_tracker_row(TaudEngine *e, int row)
{
    int i;
    e->rowIndex = iclamp(row, 0, 63);
    te_reset_play_state(e);
    for (i = 0; i < TOTAL_VOICES; i++) {
        TaudVoice *v = &e->voices[i];
        v->loopStartRow = 0; v->loopCount = 0;
        v->dittoActive = false; v->dittoSourceStart = 0; v->dittoLength = 0; v->dittoEndRow = 0;
        v->channelVolume = e->volMax;
        v->channelPan = 0x80;
        v->channelVolumeSet = false;
        v->channelPanSet = false;
        v->rowPan = 32;
        v->panAzimuth = 128.0;
        v->panElevation = 0.0;
        v->notePan = 0;
        v->noteElevation = 0.0;
        v->spatialTargetAz = 128.0;
        v->spatialTargetEl = 0.0;
        v->spatialSlideActive = false;
        v->panbrelloOffset = 0;
        v->glissandoOn = false;
        v->clipMode = 0;
        v->bitcrusherDepth = 0;
        v->bitcrusherSkip = 0;
        v->bitcrusherCounter = 0;
        v->bitcrusherHeld = 0.0;
        v->overdriveAmp = 0;
        v->right.bitcrusherCounter = 0;
        v->right.bitcrusherHeld = 0.0;
        v->nnaOverride = -1;
        v->volEnvOn = true; v->panEnvOn = true; v->pitchEnvOn = true; v->filterEnvOn = true;
    }
    te_reconstruct_ditto_state(e, e->rowIndex);
}

/* Starting real playback ends any jam audition: leftover jammed voices are
 * dropped so a held audition cannot bleed into the first rows of the song
 * (Playhead's isPlaying setter). */
void te_play(TaudEngine *e)
{
    if (!e->isPlaying && e->jamActive) {
        int i;
        for (i = 0; i < TOTAL_VOICES; i++) e->voices[i].active = false;
        for (i = 0; i < e->bgCount; i++) e->bg[i]->active = false;
        e->jamActive = false;
    }
    e->isPlaying = true;
}

/* Silence every voice the SONG owns — the lanes and the ghosts hanging off
 * them — leaving the jam bank alone, so an audition held across a stop keeps
 * sounding (Playhead.silenceSongVoices). `ramp` cuts through the note-cut
 * ramp, for a mix that is still running. */
void te_silence_song_voices(TaudEngine *e, bool ramp)
{
    int i;
    for (i = 0; i < JAM_VOICE_BASE; i++) {
        TaudVoice *v = &e->voices[i];
        if (!v->active) continue;
        if (ramp) te_start_cut_ramp(e, v); else v->active = false;
    }
    for (i = 0; i < e->bgCount; i++) {
        TaudVoice *bg = e->bg[i];
        if (!bg->active || bg->sourceChannel >= JAM_VOICE_BASE) continue;
        if (ramp) te_start_cut_ramp(e, bg); else bg->active = false;
    }
}

/* Ramped while an audition is still sounding, because that mix keeps running;
 * dropped outright otherwise, where nothing renders and nothing is heard. */
void te_stop(TaudEngine *e)
{
    e->isPlaying = false;
    te_silence_song_voices(e, e->jamActive);
}

void te_reset_sample_fx_state(TaudEngine *e)
{
    int i;
    for (i = 0; i < TOTAL_VOICES; i++) {
        TaudVoice *v = &e->voices[i];
        v->invertSpeed = 0;
        v->invertAccumulator = 0;
        v->invertWritePos = 0;
        v->funkSpeed = 0;
        v->funkMode = 0;
        v->funkAccumulator = 0;
        v->funkWalk = -1;
        v->funkPos = -1;
        v->funkWindow = -1;
        v->funkXfade = 0;
        v->modFunkWindow = -1;
        v->modFunkXfade = 0;
        v->modPeriod = 0;
        v->modTickCount = 0;
        v->modWritePos = 0;
        v->modXfade = 0;
    }
    for (i = 0; i < NUM_INST_SLOTS; i++) {
        e->instruments[i].invertMaskLen = 0;
        te_inst_reset_mod(&e->instruments[i]);
        /* The S $Axxx overlay goes with them: a new playback hears the record. */
        if (e->instruments[i].psg != NULL) te_psg_clear_runtime(e->instruments[i].psg);
    }
}

unsigned te_drain_interrupts(TaudEngine *e)
{
    unsigned m = e->pendingInterrupts;
    e->pendingInterrupts = 0;
    return m;
}

bool te_render_chunk(TaudEngine *e) { return te_generate_tracker_audio(e); }

/* Install the project's LYRICS (the `ILyr` section, §9.17): `count` decoded
 * entries, replacing whatever was installed — an instrument no entry names
 * has none. The first entry for an instrument wins. The entries must outlive
 * the engine's use of them (the player's document owns them). */
void te_set_lyrics(TaudEngine *e, const TaudLyricEntry *entries, int count)
{
    const TaudLyricEntry *by[NUM_INST_SLOTS];
    int i;
    for (i = 0; i < NUM_INST_SLOTS; i++) by[i] = NULL;
    for (i = 0; i < count; i++) {
        int id = entries[i].instId & 0x3ff;
        if (id < NUM_INST_SLOTS && by[id] == NULL) by[id] = &entries[i];
    }
    for (i = 0; i < NUM_INST_SLOTS; i++) {
        TaudInst *inst = &e->instruments[i];
        if (by[i] != inst->lyricEntry) te_inst_set_lyric(inst, by[i]);
    }
}

/* ── lifetime ── */

TaudEngine *te_engine_new(int rate)
{
    TaudEngine *e = (TaudEngine *)calloc(1, sizeof *e);
    int i;
    if (e == NULL) return NULL;
    e->rate = rate;
    e->rampOutSamples = (int)js_round(RAMP_OUT_SEC * rate);
    e->volRampSamples = (int)js_round(VOL_RAMP_SEC * rate);
    e->attackRampSamples = (int)js_round(ATTACK_RAMP_SEC * rate);
    e->sfFilterGlideSamples = (int)js_round(SF_FILTER_GLIDE_SEC * rate);
    if (e->sfFilterGlideSamples < 1) e->sfFilterGlideSamples = 1;
    e->gvolGlide.cur = NAN;
    e->mvolGlide.cur = NAN;
    e->masterGlide.cur = NAN;
    if (e->volRampSamples < 1) e->volRampSamples = 1;
    if (e->attackRampSamples < 1) e->attackRampSamples = 1;
    if (e->rampOutSamples < 1) e->rampOutSamples = 1;
    te_build_tables(e);
    te_formant_tables_init(&e->formantTables, rate);
    te_psg_tables_init(e);

    e->instruments = (TaudInst *)calloc(NUM_INST_SLOTS, sizeof(TaudInst));
    e->playdata = (TaudCell **)calloc(NUM_PATTERNS, sizeof(TaudCell *));
    if (e->instruments == NULL || e->playdata == NULL) {
        te_engine_free(e);
        return NULL;
    }
    for (i = 0; i < NUM_INST_SLOTS; i++) {
        te_inst_init(&e->instruments[i], i);
        e->instruments[i].engine = e;
    }
    e->retireSweepAt = RETIRE_SWEEP_COUNT;
    e->jamLyricInst = -1;
    e->rendererKind = -1;
    for (i = 0; i < ROWS_PER_PATTERN; i++) e->emptyPattern[i].pan = 32;
    cue_init(&e->emptyCue);

    /* Playhead defaults. */
    e->masterPan = 128;
    e->bpm = 125;
    e->tickRate = 6;
    e->globalVolume = 0x80;
    e->mixingVolume = 0x80;

    /* TrackerState defaults. */
    e->firstRow = true;
    for (i = 0; i < TOTAL_VOICES; i++) te_voice_init(&e->voices[i]);
    e->volMax = VOLUME_MAX;
    e->volStep = 1;
    e->volDiv = 63.0;
    e->tuningRatio = 1.0;
    te_mastering_default(&e->masteringParams);
    e->hasMasteringParams = true;
    e->pendingOrderJump = -1;
    e->pendingRowJump = -1;
    e->sexWinningChannel = -1;

    e->xorshift = TE_XORSHIFT_SEED;
    e->mulberry = 1;
    if (!pool_grow(e, POOL_CHUNK * 2)) { te_engine_free(e); return NULL; }
    return e;
}

void te_engine_free(TaudEngine *e)
{
    int i;
    TaudVoiceChunk *c;
    if (e == NULL) return;
    if (e->instruments != NULL) {
        for (i = 0; i < NUM_INST_SLOTS; i++) te_inst_free(&e->instruments[i]);
        free(e->instruments);
    }
    if (e->playdata != NULL) {
        for (i = 0; i < NUM_PATTERNS; i++) if (!is_shared_blank(e, e->playdata[i])) free(e->playdata[i]);
        free(e->playdata);
    }
    free(e->sharedBlank[0]);
    free(e->sharedBlank[1]);
    for (i = 0; i < CUE_BLOCKS; i++) free(e->cueBlocks[i]);
    free(e->bg);
    c = e->chunks;
    while (c != NULL) { TaudVoiceChunk *n = c->next; free(c); c = n; }
    free(e->spatial);
    free(e->analysisBus);
    for (i = 0; i < IMX_METER_SEATS; i++) free(e->imixMeters[i]);
    free(e->stemLog);
    te_binaural_free(e->binaural);
    te_master_chain_free(e->mastering);
    te_imix_free_routes(e);
    for (i = 0; i < e->retiredCount; i++) free(e->retired[i].ptr);
    free(e->retired);
    free(e->ownPool);
    free(e->ownImix);
    te_lyrics_free(e->ownLyrics, e->ownLyricCount);
    free(e);
}
