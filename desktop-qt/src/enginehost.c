/* The native audio host's engine side — see enginehost.h. Each case below is
 * the WasmTaudEngine method (core/engine/wasm-engine.js) the web build's
 * dispatcher calls, with the same arguments: the page lowered them with the
 * same conversions (a boolean to 0/1, a number through `| 0`), so a native
 * engine is given exactly what a WebAssembly one is. */
#include "enginehost.h"

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"
#include "snap_layout.h"

/* ── the host API (wasm_api.c, snapshot.c): no header, as its only caller
 *    used to be JavaScript ── */
TaudEngine *tw_new(int rate);
void tw_free(TaudEngine *e);
void tw_seed(TaudEngine *e, uint32_t seed);
int tw_oom(const TaudEngine *e);
void tw_upload_sample_inst(TaudEngine *e, uint8_t *pool, uint32_t poolLen, const uint8_t *inst, int instCount);
void tw_upload_instrument(TaudEngine *e, int slot, const uint8_t *bytes, uint32_t len);
void tw_upload_instrument_patches(TaudEngine *e, int slot, const uint8_t *bytes, uint32_t len);
void tw_clear_instrument_patches(TaudEngine *e, int slot);
void tw_upload_pattern(TaudEngine *e, int slot, const uint8_t *bytes, uint32_t len);
void tw_clear_pattern(TaudEngine *e, int slot);
void tw_upload_cue(TaudEngine *e, int idx, const uint8_t *bytes, uint32_t len);
void tw_set_64_channel_mode(TaudEngine *e, int on);
void tw_set_cell_format(TaudEngine *e, int wide);
int tw_get_cell_format(const TaudEngine *e);
void tw_set_bpm(TaudEngine *e, int bpm);
void tw_set_tuning(TaudEngine *e, int baseNote, double freq);
void tw_set_tick_rate(TaudEngine *e, int rate);
void tw_set_song_global_volume(TaudEngine *e, int v);
void tw_set_song_mixing_volume(TaudEngine *e, int v);
void tw_set_master_volume(TaudEngine *e, int v);
void tw_set_master_pan(TaudEngine *e, int v);
void tw_set_tracker_mixer_flags(TaudEngine *e, int flags);
void tw_set_surround_model(TaudEngine *e, int model);
void tw_set_monitor_mode(TaudEngine *e, int mode);
void tw_set_analysis(TaudEngine *e, int target, int layout);
int tw_set_mastering(TaudEngine *e, const uint8_t *block, uint32_t len);
void tw_set_master_meter(TaudEngine *e, int on, int scramble, int depth, int span);
int tw_set_imix(TaudEngine *e, const uint8_t *section, uint32_t len);
int tw_set_lyrics(TaudEngine *e, const uint8_t *section, uint32_t len);
void tw_set_pitch_ext(TaudEngine *e, const uint8_t *section, uint32_t len);
void tw_set_imix_meter(TaudEngine *e, int slot, int seat);
void tw_play(TaudEngine *e);
void tw_stop(TaudEngine *e);
void tw_set_cue_position(TaudEngine *e, int pos);
void tw_set_tracker_row(TaudEngine *e, int row);
int tw_chase_tracker_row(TaudEngine *e, int cue, int row);
void tw_reset_params(TaudEngine *e);
void tw_reset_sample_fx_state(TaudEngine *e);
void tw_jam_note(TaudEngine *e, int vi, int note, int inst, int audition);
void tw_jam_sample(TaudEngine *e, int vi, int note, const int32_t *spec);
void tw_jam_stop(TaudEngine *e);
void tw_jam_stop_voice(TaudEngine *e, int vi);
void tw_jam_key_off(TaudEngine *e, int vi);
void tw_jam_release(TaudEngine *e, int vi);
void tw_set_voice_fader(TaudEngine *e, int vi, int fader);
int tw_is_playing(const TaudEngine *e);
int tw_jam_active(const TaudEngine *e);
int tw_render_frames(TaudEngine *e, int frames);
int tw_span_frames(const TaudEngine *e);
const float *tw_mix_left(const TaudEngine *e);
const float *tw_mix_right(const TaudEngine *e);
void tw_pcm8(TaudEngine *e, uint8_t *out);
unsigned tw_poll_interrupts(TaudEngine *e);
int tw_interrupt_arg(const TaudEngine *e, int n);
void tw_fill_snapshot(TaudEngine *e, float *f);
int tw_get_invert_mask(const TaudEngine *e, int slot, uint8_t *out, int cap);
int tw_get_mod_mask(const TaudEngine *e, int slot, uint8_t *out, int cap);
void tw_get_sample_mod(const TaudEngine *e, int slot, double *out);
int tw_get_psg_state(const TaudEngine *e, int slot, int *out);
int tw_get_fadeout_state(const TaudEngine *e, int slot, int *out, int cap);
int tw_get_fm_vibrato_state(const TaudEngine *e, int slot, int *out, int cap);
int tw_get_formant_state(const TaudEngine *e, int slot, double *voices, int *extra, int *lyric, int lyricCap,
                         int *counts);
int tw_sounding_voices(const TaudEngine *e);

/* What a reply carries (and the page's decoders read: wasm-engine.js). */
#define SAMPLE_MOD_DOUBLES 25
#define PSG_INTS 8
#define FADEOUT_CAP 16
#define FM_VIBRATO_CAP 32
#define FORMANT_VOICES 8
#define FORMANT_DOUBLES 13
#define MASK_CAP 8192

/* The reply's kind byte (native-engine.js NATIVE_MSG). */
#define REPLY_INVERT_MASK 2

struct MtHost {
    TaudEngine *e;
    int rate;
    int snapshotIntervalMs;
    /* The master strip's tap as last asked for (kind -1 = off): every call
     * that moves the surround model or the render target installs it again,
     * as WasmTaudEngine.setAnalysis is re-run. */
    int analysisKind, analysisLayout;
    int masterMeterOn;
    float *snap;        /* the engine writes its snapshot here */
    uint8_t *census;    /* the dither's output, for the Mastering census */
};

MtHost *mt_host_new(int rate)
{
    MtHost *h = (MtHost *)calloc(1, sizeof *h);
    if (h == NULL) return NULL;
    h->rate = rate;
    h->snapshotIntervalMs = 16;
    h->analysisKind = -1;
    h->snap = (float *)calloc(SNAP_FLOATS, sizeof(float));
    h->census = (uint8_t *)malloc(TRACKER_CHUNK * 2);
    if (h->snap == NULL || h->census == NULL) { mt_host_free(h); return NULL; }
    return h;
}

void mt_host_free(MtHost *h)
{
    if (h == NULL) return;
    if (h->e != NULL) tw_free(h->e);
    free(h->snap);
    free(h->census);
    free(h);
}

int mt_host_rate(const MtHost *h) { return h->rate; }
int mt_host_has_engine(const MtHost *h) { return h->e != NULL; }
int mt_host_snapshot_interval_ms(const MtHost *h) { return h->snapshotIntervalMs; }

static int32_t arg_int(const MtCommand *c, int k)
{
    int32_t v = 0;
    if (k < c->nInts) memcpy(&v, (const uint8_t *)c->ints + (size_t)k * 4, 4);
    return v;
}

static double arg_double(const MtCommand *c, int k)
{
    double v = 0.0;
    if (k < c->nDoubles) memcpy(&v, (const uint8_t *)c->doubles + (size_t)k * 8, 8);
    return v;
}

static int is(const MtCommand *c, const char *name)
{
    size_t n = strlen(name);
    return (size_t)c->nameLen == n && memcmp(c->name, name, n) == 0;
}

static void reapply_analysis(MtHost *h)
{
    tw_set_analysis(h->e, h->analysisKind, h->analysisKind < 0 ? 0 : h->analysisLayout);
}

/* uploadSampleInstBlob: the pool trimmed to its last non-zero byte and handed
 * over (the engine owns it), then up to 1024 records. */
static void upload_sample_inst(TaudEngine *e, const uint8_t *image, uint32_t len)
{
    uint32_t n = SAMPLE_BIN_TOTAL;
    uint8_t *pool = NULL;
    int instCount;
    if (len < (uint32_t)SAMPLE_BIN_TOTAL + 65536u) return;
    while (n > 0 && image[n - 1] == 0) n--;
    if (n > 0) {
        pool = (uint8_t *)malloc(n);
        if (pool == NULL) return;
        memcpy(pool, image, n);
    }
    instCount = (int)((len - SAMPLE_BIN_TOTAL) / 256);
    if (instCount > 1024) instCount = 1024;
    tw_upload_sample_inst(e, pool, n, image + SAMPLE_BIN_TOTAL, instCount);
}

/* ── a growable reply ── */
typedef struct { uint8_t *p; size_t len, cap; int failed; } Buf;

static void put(Buf *b, const void *src, size_t n)
{
    if (b->failed) return;
    if (b->len + n > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 4096;
        uint8_t *q;
        while (cap < b->len + n) cap *= 2;
        q = (uint8_t *)realloc(b->p, cap);
        if (q == NULL) { b->failed = 1; return; }
        b->p = q;
        b->cap = cap;
    }
    memcpy(b->p + b->len, src, n);
    b->len += n;
}

static void put_i32(Buf *b, int32_t v) { put(b, &v, 4); }

/* WasmTaudEngine._mask: an 8 KiB try, then exactly what it said it needs. */
static void put_mask(Buf *b, int (*fn)(const TaudEngine *, int, uint8_t *, int), const TaudEngine *e, int slot)
{
    uint8_t *tmp = (uint8_t *)malloc(MASK_CAP);
    int n = tmp != NULL ? fn(e, slot, tmp, MASK_CAP) : 0;
    if (n > MASK_CAP) {
        uint8_t *big = (uint8_t *)realloc(tmp, (size_t)n);
        if (big == NULL) n = 0;
        else { tmp = big; n = fn(e, slot, tmp, n); }
    }
    if (n < 0) n = 0;
    put_i32(b, n);
    if (n > 0) put(b, tmp, (size_t)n);
    free(tmp);
}

/* The QUERY_INVERT_MASK reply: the raw figures the page's decoders turn into
 * what MSG.INVERT_MASK carries (render.worker.js). Little-endian throughout. */
static int reply_invert_mask(MtHost *h, int slot, uint8_t **reply, size_t *replyLen)
{
    TaudEngine *e = h->e;
    Buf b = {0};
    uint8_t kind[4] = {REPLY_INVERT_MASK, 0, 0, 0};
    double mod[SAMPLE_MOD_DOUBLES];
    int psg[PSG_INTS], fade[FADEOUT_CAP * 2], vib[FM_VIBRATO_CAP * 4];
    double fv[FORMANT_VOICES * FORMANT_DOUBLES];
    int fextra[FORMANT_VOICES * 2], flyric[TOTAL_VOICES], fcounts[2];
    int ok, n;

    put(&b, kind, 4);
    put_i32(&b, slot);
    put_mask(&b, tw_get_invert_mask, e, slot);
    put_mask(&b, tw_get_mod_mask, e, slot);

    memset(mod, 0, sizeof mod);
    tw_get_sample_mod(e, slot, mod);
    put(&b, mod, sizeof mod);

    memset(psg, 0, sizeof psg);
    ok = tw_get_psg_state(e, slot, psg);
    put_i32(&b, ok ? 1 : 0);
    put(&b, psg, sizeof psg);

    memset(fade, 0, sizeof fade);
    n = tw_get_fadeout_state(e, slot, fade, FADEOUT_CAP);
    put_i32(&b, n);
    put(&b, fade, sizeof fade);

    memset(vib, 0, sizeof vib);
    n = tw_get_fm_vibrato_state(e, slot, vib, FM_VIBRATO_CAP);
    put_i32(&b, n);
    put(&b, vib, sizeof vib);

    memset(fv, 0, sizeof fv);
    memset(fextra, 0, sizeof fextra);
    memset(flyric, 0, sizeof flyric);
    memset(fcounts, 0, sizeof fcounts);
    ok = tw_get_formant_state(e, slot, fv, fextra, flyric, TOTAL_VOICES, fcounts);
    put_i32(&b, ok ? 1 : 0);
    put(&b, fv, sizeof fv);
    put(&b, fextra, sizeof fextra);
    put(&b, fcounts, sizeof fcounts);
    put_i32(&b, TOTAL_VOICES);
    put(&b, flyric, sizeof flyric);

    if (b.failed) { free(b.p); return MT_IGNORED; }
    *reply = b.p;
    *replyLen = b.len;
    return MT_REPLIED;
}

int mt_host_apply(MtHost *h, const MtCommand *c, uint8_t **reply, size_t *replyLen)
{
    TaudEngine *e;
    const uint8_t *b0 = c->nBlobs > 0 ? c->blob[0] : NULL;
    uint32_t l0 = c->nBlobs > 0 ? c->blobLen[0] : 0;

    if (is(c, "INIT")) {
        if (h->e != NULL) tw_free(h->e);
        h->e = tw_new(h->rate);
        if (h->e == NULL) return MT_IGNORED;
        tw_seed(h->e, (uint32_t)arg_int(c, 0));
        h->snapshotIntervalMs = arg_int(c, 1) > 0 ? arg_int(c, 1) : 16;
        h->analysisKind = -1;
        h->analysisLayout = 0;
        h->masterMeterOn = 0;
        return MT_APPLIED;
    }
    e = h->e;
    if (e == NULL) return MT_IGNORED;

    /* content upload */
    if (is(c, "UPLOAD_SAMPLE_INST_BLOB")) { if (b0) upload_sample_inst(e, b0, l0); return MT_APPLIED; }
    if (is(c, "UPLOAD_INSTRUMENT")) { tw_upload_instrument(e, arg_int(c, 0), b0, l0 > 256 ? 256 : l0); return MT_APPLIED; }
    if (is(c, "UPLOAD_INSTRUMENT_PATCHES")) { tw_upload_instrument_patches(e, arg_int(c, 0), b0, l0); return MT_APPLIED; }
    if (is(c, "CLEAR_INSTRUMENT_PATCHES")) { tw_clear_instrument_patches(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "UPLOAD_PATTERN")) { tw_upload_pattern(e, arg_int(c, 0), b0, l0); return MT_APPLIED; }
    if (is(c, "UPLOAD_PATTERNS")) {
        /* The stride follows the cell layout SET_CELL_FORMAT installed. */
        uint32_t size = tw_get_cell_format(e) ? PATTERN_BYTES_WIDE : PATTERN_BYTES;
        int i;
        for (i = 0; i < c->nInts; i++) {
            uint32_t from = (uint32_t)i * size, n;
            if (from >= l0) n = 0;
            else n = l0 - from < size ? l0 - from : size;
            tw_upload_pattern(e, arg_int(c, i), n ? b0 + from : b0, n);
        }
        return MT_APPLIED;
    }
    if (is(c, "CLEAR_PATTERN")) { tw_clear_pattern(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "UPLOAD_CUE")) { tw_upload_cue(e, arg_int(c, 0), b0, l0); return MT_APPLIED; }
    if (is(c, "SET_64CH")) { tw_set_64_channel_mode(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_CELL_FORMAT")) { tw_set_cell_format(e, arg_int(c, 0)); return MT_APPLIED; }

    /* the song's parameters */
    if (is(c, "SET_BPM")) { tw_set_bpm(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_TUNING")) { tw_set_tuning(e, arg_int(c, 0), arg_double(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_TICK_RATE")) { tw_set_tick_rate(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_SONG_GLOBAL_VOLUME")) { tw_set_song_global_volume(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_SONG_MIXING_VOLUME")) { tw_set_song_mixing_volume(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_MASTER_VOLUME")) { tw_set_master_volume(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_MASTER_PAN")) { tw_set_master_pan(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_TRACKER_MIXER_FLAGS")) { tw_set_tracker_mixer_flags(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_SURROUND_MODEL")) { tw_set_surround_model(e, arg_int(c, 0)); reapply_analysis(h); return MT_APPLIED; }
    if (is(c, "SET_MONITOR_MODE")) { tw_set_monitor_mode(e, arg_int(c, 0)); reapply_analysis(h); return MT_APPLIED; }

    /* chains, lyrics, taps */
    if (is(c, "SET_ANALYSIS")) {
        h->analysisKind = arg_int(c, 0);
        h->analysisLayout = arg_int(c, 1);
        reapply_analysis(h);
        return MT_APPLIED;
    }
    if (is(c, "SET_MASTERING")) { tw_set_mastering(e, l0 ? b0 : NULL, l0); return MT_APPLIED; }
    if (is(c, "SET_MASTER_METER")) {
        h->masterMeterOn = arg_int(c, 0) != 0;
        tw_set_master_meter(e, arg_int(c, 0), arg_int(c, 1), arg_int(c, 2), arg_int(c, 3));
        return MT_APPLIED;
    }
    if (is(c, "SET_IMIX")) { tw_set_imix(e, l0 ? b0 : NULL, l0); return MT_APPLIED; }
    if (is(c, "SET_LYRICS")) { tw_set_lyrics(e, l0 ? b0 : NULL, l0); return MT_APPLIED; }
    if (is(c, "SET_PITCH_EXT")) { tw_set_pitch_ext(e, l0 ? b0 : NULL, l0); return MT_APPLIED; }
    if (is(c, "SET_IMIX_METER")) { tw_set_imix_meter(e, arg_int(c, 0), arg_int(c, 1)); return MT_APPLIED; }

    /* transport */
    if (is(c, "PLAY")) { tw_play(e); return MT_APPLIED; }
    if (is(c, "STOP")) { tw_stop(e); return MT_APPLIED; }
    if (is(c, "SET_CUE_POSITION")) { tw_set_cue_position(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_TRACKER_ROW")) { tw_set_tracker_row(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "CHASE_TRACKER_ROW")) { tw_chase_tracker_row(e, arg_int(c, 0), arg_int(c, 1)); return MT_APPLIED; }
    if (is(c, "RESET_PARAMS")) { tw_reset_params(e); reapply_analysis(h); return MT_APPLIED; }
    if (is(c, "RESET_SAMPLE_FX_STATE")) { tw_reset_sample_fx_state(e); return MT_APPLIED; }

    /* jam / audition and the desk */
    if (is(c, "JAM_NOTE")) {
        tw_jam_note(e, arg_int(c, 0), arg_int(c, 1), arg_int(c, 2), arg_int(c, 3));
        return MT_APPLIED;
    }
    if (is(c, "JAM_SAMPLE")) {
        int32_t spec[12];
        memset(spec, 0, sizeof spec);
        if (b0) memcpy(spec, b0, l0 < sizeof spec ? l0 : sizeof spec);
        tw_jam_sample(e, arg_int(c, 0), arg_int(c, 1), spec);
        return MT_APPLIED;
    }
    if (is(c, "JAM_STOP")) { tw_jam_stop(e); return MT_APPLIED; }
    if (is(c, "JAM_STOP_VOICE")) { tw_jam_stop_voice(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "JAM_KEY_OFF")) { tw_jam_key_off(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "JAM_RELEASE")) { tw_jam_release(e, arg_int(c, 0)); return MT_APPLIED; }
    if (is(c, "SET_VOICE_FADER")) { tw_set_voice_fader(e, arg_int(c, 0), arg_int(c, 1)); return MT_APPLIED; }

    if (is(c, "QUERY_INVERT_MASK")) return reply_invert_mask(h, arg_int(c, 0), reply, replyLen);
    return MT_UNKNOWN;
}

int mt_host_active(const MtHost *h)
{
    return h->e != NULL && (tw_is_playing(h->e) || tw_jam_active(h->e));
}

int mt_host_render(MtHost *h, float *out, int frames)
{
    int done = 0;
    if (!mt_host_active(h)) {
        memset(out, 0, sizeof(float) * 2 * (size_t)frames);
        return 0;
    }
    while (done < frames) {
        int want = frames - done < TRACKER_CHUNK ? frames - done : TRACKER_CHUNK;
        const float *L, *R;
        int n, i;
        /* A halted song renders nothing more: silence for the rest. */
        if (!tw_render_frames(h->e, want)) {
            memset(out + done * 2, 0, sizeof(float) * 2 * (size_t)(frames - done));
            break;
        }
        n = tw_span_frames(h->e);
        /* As renderChunk: the device's 8-bit codes are made too, because the
         * Mastering view's census counts them. */
        tw_pcm8(h->e, h->census);
        L = tw_mix_left(h->e);
        R = tw_mix_right(h->e);
        for (i = 0; i < n; i++) {
            out[(done + i) * 2] = L[i];
            out[(done + i) * 2 + 1] = R[i];
        }
        done += n;
    }
    return 1;
}

int mt_host_sounding_voices(const MtHost *h) { return h->e != NULL ? tw_sounding_voices(h->e) : 0; }

static void copy_range(float *out, const float *in, int from, int to)
{
    if (to > from) memcpy(out + from, in + from, sizeof(float) * (size_t)(to - from));
}

void mt_host_fill_snapshot(MtHost *h, float *out, int *analysisOn, int *meterOn)
{
    *analysisOn = 0;
    *meterOn = 0;
    if (h->e == NULL) return;
    tw_fill_snapshot(h->e, h->snap);
    /* engine-commands.js fillSnapshotInto, range for range. */
    copy_range(out, h->snap, 0, SNAP_INTERRUPT_MASK);
    copy_range(out, h->snap, SNAP_INTERRUPT_MASK + 1, SNAP_INTERRUPT_ARGS);
    copy_range(out, h->snap, SNAP_HEADER_SIZE, SNAP_METER_BASE);
    if (h->analysisKind >= 0) { copy_range(out, h->snap, SNAP_METER_BASE, SNAP_MM_BASE); *analysisOn = 1; }
    if (h->masterMeterOn) { copy_range(out, h->snap, SNAP_MM_BASE, SNAP_IM_BASE); *meterOn = 1; }
    copy_range(out, h->snap, SNAP_IM_BASE, SNAP_FLOATS);
}

uint32_t mt_host_drain_interrupts(MtHost *h, int32_t args[16])
{
    unsigned mask;
    int n;
    if (h->e == NULL) return 0;
    mask = tw_poll_interrupts(h->e);
    for (n = 0; n < 16; n++) {
        if (mask & (1u << n)) args[n] = tw_interrupt_arg(h->e, n);
    }
    return (uint32_t)mask;
}

int mt_snap_floats(void) { return SNAP_FLOATS; }

void mt_snap_layout(MtSnapLayout *o)
{
    o->floats = SNAP_FLOATS;
    o->interruptMask = SNAP_INTERRUPT_MASK;
    o->interruptArgs = SNAP_INTERRUPT_ARGS;
    o->headerSize = SNAP_HEADER_SIZE;
    o->meterBase = SNAP_METER_BASE;
    o->mmBase = SNAP_MM_BASE;
    o->imBase = SNAP_IM_BASE;
    o->imStride = SNAP_IM_STRIDE;
    o->imSeats = SNAP_IM_SEATS;
    o->imSlot = SNAP_IM_SLOT;
    o->epBase = SNAP_EP_BASE;
    o->epEntries = SNAP_EP_ENTRIES;
    o->epStride = SNAP_EP_STRIDE;
    o->epCount = SNAP_EP_COUNT;
}
