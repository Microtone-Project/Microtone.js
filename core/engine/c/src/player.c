/* The public surface — port of taudplay/render.js (TaudRenderer), faders.js
 * and interrupts.js. Same file, same songs, same knobs, same two probes. */

#include <stdlib.h>
#include <string.h>

#include "taud_internal.h"

/* ── the fader bank (faders.js) ── */

typedef struct {
    double now[MAX_VOICES];     /* current attenuation, 0..255 */
    double target[MAX_VOICES];
    double step[MAX_VOICES];    /* per frame */
    double remain[MAX_VOICES];  /* frames left in the ramp */
    bool dirty;
} FaderBank;

static void faders_set(FaderBank *f, int v, double value, double samples)
{
    double target;
    if (v < 0 || v >= MAX_VOICES) return;
    target = value < 0 ? 0 : value > 255 ? 255 : value;
    f->target[v] = target;
    if (samples <= 0) {
        f->now[v] = target;
        f->remain[v] = 0;
        f->step[v] = 0;
    } else {
        f->step[v] = (target - f->now[v]) / samples;
        f->remain[v] = samples;
    }
    f->dirty = true;
}

static void faders_advance(FaderBank *f, int frames)
{
    int v;
    for (v = 0; v < MAX_VOICES; v++) {
        double left = f->remain[v];
        if (left <= 0) continue;
        if (left <= frames) {
            f->now[v] = f->target[v];
            f->remain[v] = 0;
        } else {
            f->now[v] += f->step[v] * frames;
            f->remain[v] = left - frames;
        }
        f->dirty = true;
    }
}

static void faders_write_into(FaderBank *f, TaudEngine *e)
{
    int v;
    if (!f->dirty) return;
    f->dirty = false;
    for (v = 0; v < MAX_VOICES; v++) {
        int b = (int)js_round(f->now[v]) & 255;
        if (e->voices[v].fader != b) e->voices[v].fader = b;
    }
}

int taud_gain_to_fader(double gain)
{
    double g = gain < 0 ? 0 : gain > 1 ? 1 : gain;
    return (int)js_round((1 - g) * 255);
}

double taud_fader_to_gain(int fader) { return (255 - fader) / 255.0; }

/* ── the player ── */

struct TaudPlayer {
    TaudDoc doc;
    TaudEngine *engine;
    FaderBank faders;
    int monitor;
    int songIndex;
    char **songNames;
    struct { TaudInterruptFn fn; void *user; } interrupts[TAUD_NUM_INTERRUPTS];
    float out[TRACKER_CHUNK * 2];
    uint8_t outU8[TRACKER_CHUNK * 2];
    int pendingPos;             /* frames of `out` already handed to taud_render */
    int pendingLen;
};

void taud_config_init(TaudConfig *cfg)
{
    memset(cfg, 0, sizeof *cfg);
    cfg->sample_rate = TAUD_DEFAULT_RATE;
    cfg->song_index = 0;
    cfg->binaural = 0;
    cfg->random_seed = 1;
}

const char *taud_error_string(TaudError err)
{
    switch (err) {
    case TAUD_OK: return "ok";
    case TAUD_ERR_NOMEM: return "out of memory";
    case TAUD_ERR_FORMAT: return "not a valid Taud file";
    case TAUD_ERR_NOT_A_SONG: return "the file holds no song to play (need a full .taud)";
    case TAUD_ERR_DECOMPRESS: return "a compressed section did not decode";
    case TAUD_ERR_RANGE: return "song index out of range";
    default: return "unknown error";
    }
}

TaudPlayer *taud_open(const void *bytes, size_t len, const TaudConfig *cfgIn, TaudError *err)
{
    TaudConfig cfg;
    TaudPlayer *p;
    TaudError e;
    int i;
    if (err != NULL) *err = TAUD_OK;
    if (cfgIn != NULL) cfg = *cfgIn; else taud_config_init(&cfg);
    if (cfg.sample_rate <= 0) cfg.sample_rate = TAUD_DEFAULT_RATE;

    p = (TaudPlayer *)calloc(1, sizeof *p);
    if (p == NULL) { if (err) *err = TAUD_ERR_NOMEM; return NULL; }
    e = te_parse_taud((const uint8_t *)bytes, len, &p->doc);
    if (e != TAUD_OK) { free(p); if (err) *err = e; return NULL; }
    if (p->doc.kind != 0 || p->doc.numSongs == 0) {
        te_doc_free(&p->doc);
        free(p);
        if (err) *err = TAUD_ERR_NOT_A_SONG;
        return NULL;
    }
    p->songNames = (char **)calloc((size_t)p->doc.numSongs, sizeof(char *));
    p->engine = te_engine_new(cfg.sample_rate);
    if (p->songNames == NULL || p->engine == NULL) { taud_close(p); if (err) *err = TAUD_ERR_NOMEM; return NULL; }
    for (i = 0; i < p->doc.numSongs; i++) {
        const char *nm = p->doc.songs[i].name;
        if (nm != NULL && nm[0] != 0) {
            p->songNames[i] = (char *)malloc(strlen(nm) + 1);
            if (p->songNames[i] != NULL) strcpy(p->songNames[i], nm);
        } else {
            /* "song N", written by hand: printf would be the engine's only
             * use of stdio, and a WebAssembly build must import nothing. */
            char *s = (char *)malloc(16);
            p->songNames[i] = s;
            if (s != NULL) {
                char digits[10];
                int n = 0, v = i;
                memcpy(s, "song ", 5);
                s += 5;
                do { digits[n++] = (char)('0' + v % 10); v /= 10; } while (v > 0);
                while (n > 0) *s++ = digits[--n];
                *s = 0;
            }
        }
    }
    p->engine->random = cfg.random;
    p->engine->randomUser = cfg.random_user;
    p->engine->mulberry = cfg.random_seed;
    p->monitor = cfg.binaural ? MONITOR_BINAURAL : MONITOR_FOLD;
    p->faders.dirty = true;
    p->songIndex = -1;
    e = taud_select_song(p, cfg.song_index);
    if (e != TAUD_OK || p->engine->oom) {
        taud_close(p);
        if (err) *err = e != TAUD_OK ? e : TAUD_ERR_NOMEM;
        return NULL;
    }
    return p;
}

void taud_close(TaudPlayer *p)
{
    int i;
    if (p == NULL) return;
    te_engine_free(p->engine);
    if (p->songNames != NULL) {
        for (i = 0; i < p->doc.numSongs; i++) free(p->songNames[i]);
        free(p->songNames);
    }
    te_doc_free(&p->doc);
    free(p);
}

const char *taud_title(const TaudPlayer *p) { return p->doc.projectName; }
int taud_song_count(const TaudPlayer *p) { return p->doc.numSongs; }
int taud_current_song(const TaudPlayer *p) { return p->songIndex; }
int taud_sample_rate(const TaudPlayer *p) { return p->engine->rate; }

int taud_song_info(const TaudPlayer *p, int index, TaudSongInfo *out)
{
    const TaudSong *s;
    if (index < 0 || index >= p->doc.numSongs) return 0;
    s = &p->doc.songs[index];
    out->index = index;
    out->name = p->songNames[index] != NULL ? p->songNames[index] : "";
    out->patterns = s->numPats;
    out->bpm = s->bpm;
    out->channels = s->numVoices;
    out->surround = s->surroundModel != 0;
    return 1;
}

TaudError taud_select_song(TaudPlayer *p, int index)
{
    TaudEngine *e = p->engine;
    if (index < 0 || index >= p->doc.numSongs) return TAUD_ERR_RANGE;
    p->songIndex = index;
    te_stop(e);
    te_load_into_engine(e, &p->doc, index);
    te_set_monitor_mode(e, p->monitor);
    p->faders.dirty = true;
    faders_write_into(&p->faders, e);
    p->pendingPos = p->pendingLen = 0;
    return e->oom ? TAUD_ERR_NOMEM : TAUD_OK;
}

/* ── transport ── */

void taud_play(TaudPlayer *p)
{
    TaudEngine *e = p->engine;
    te_reset_sample_fx_state(e);
    te_set_cue_position(e, 0);
    te_set_tracker_row(e, 0);
    te_play(e);
    p->pendingPos = p->pendingLen = 0;
}

void taud_stop(TaudPlayer *p)
{
    te_stop(p->engine);
    p->pendingPos = p->pendingLen = 0;
}

void taud_seek_cue(TaudPlayer *p, int cue)
{
    te_set_cue_position(p->engine, cue < 0 ? 0 : cue);
    te_set_tracker_row(p->engine, 0);
    p->pendingPos = p->pendingLen = 0;
}

void taud_set_volume(TaudPlayer *p, double gain)
{
    double g = gain < 0 ? 0 : gain > 1 ? 1 : gain;
    p->engine->masterVolume = (int)js_round(g * 255) & 255;
}

void taud_set_binaural(TaudPlayer *p, int on)
{
    p->monitor = on ? MONITOR_BINAURAL : MONITOR_FOLD;
    te_set_monitor_mode(p->engine, p->monitor);
}

int taud_is_playing(const TaudPlayer *p) { return p->engine->isPlaying; }
int taud_cue(const TaudPlayer *p) { return p->engine->cuePos; }
int taud_row(const TaudPlayer *p) { return p->engine->rowIndex; }
int taud_bpm(const TaudPlayer *p) { return p->engine->bpm; }
int taud_speed(const TaudPlayer *p) { return p->engine->tickRate; }
int taud_channel_count(const TaudPlayer *p) { return te_channel_count(p->engine); }

/* ── the knob ── */

void taud_set_voice_gain(TaudPlayer *p, int v, double gain, double fade_seconds)
{
    double samples = js_round(fade_seconds * p->engine->rate);
    faders_set(&p->faders, v, taud_gain_to_fader(gain), samples > 0 ? samples : 0);
    faders_write_into(&p->faders, p->engine);
}

double taud_get_voice_gain(const TaudPlayer *p, int v)
{
    if (v < 0 || v >= MAX_VOICES) return 1.0;
    return taud_fader_to_gain((int)js_round(p->faders.now[v]));
}

/* ── the probes ── */

double taud_get_voice_volume(const TaudPlayer *p, int v)
{
    const TaudVoice *voice;
    double effEnvVol, faderGain, ev;
    if (v < 0 || v >= MAX_VOICES) return 0;
    voice = &p->engine->voices[v];
    if (!voice->active) return 0;
    /* render.js's own reading, which (unlike the engine's internal probe)
     * does not consult the envelope's P bit. */
    effEnvVol = voice->volEnvOn ? voice->envVolMix : 1.0;
    faderGain = (255 - voice->fader) / 255.0;
    ev = effEnvVol * voice->fadeoutMix * voice->currentMixVolume * faderGain;
    return ev < 0 ? 0 : ev > 1 ? 1 : ev;
}

double taud_get_voice_pan(const TaudPlayer *p, int v)
{
    const TaudVoice *voice;
    if (v < 0 || v >= MAX_VOICES) return 0.5;
    voice = &p->engine->voices[v];
    if (!voice->active) return 0.5;
    return te_display_pan_byte(p->engine, v, voice) / 255.0;
}

/* ── interrupts ── */

void taud_set_interrupt(TaudPlayer *p, int n, TaudInterruptFn fn, void *user)
{
    if (n < 0 || n >= TAUD_NUM_INTERRUPTS) return;
    p->interrupts[n].fn = fn;
    p->interrupts[n].user = fn != NULL ? user : NULL;
}

void taud_clear_interrupts(TaudPlayer *p) { memset(p->interrupts, 0, sizeof p->interrupts); }

static void dispatch_interrupts(TaudPlayer *p)
{
    unsigned mask = te_drain_interrupts(p->engine);
    int n;
    if (mask == 0) return;
    for (n = 0; n < TAUD_NUM_INTERRUPTS; n++) {
        if (!(mask & (1u << n)) || p->interrupts[n].fn == NULL) continue;
        p->interrupts[n].fn(n, p->engine->interruptArgs[n], p->interrupts[n].user);
    }
}

/* ── rendering ── */

static bool render_block(TaudPlayer *p)
{
    TaudEngine *e = p->engine;
    int n;
    if (!e->isPlaying) return false;
    faders_advance(&p->faders, TRACKER_CHUNK);
    faders_write_into(&p->faders, e);
    if (!te_render_chunk(e)) return false;
    dispatch_interrupts(p);
    for (n = 0; n < TRACKER_CHUNK; n++) {
        p->out[n * 2] = e->mixLeft[n];
        p->out[n * 2 + 1] = e->mixRight[n];
    }
    return true;
}

const float *taud_render_chunk(TaudPlayer *p)
{
    p->pendingPos = p->pendingLen = 0;
    return render_block(p) ? p->out : NULL;
}

const uint8_t *taud_render_chunk_u8(TaudPlayer *p)
{
    p->pendingPos = p->pendingLen = 0;
    if (!render_block(p)) return NULL;
    te_pcm32f_to_pcm8(p->engine, p->outU8);
    return p->outU8;
}

size_t taud_render(TaudPlayer *p, float *out, size_t frames)
{
    size_t done = 0, real = 0;
    while (done < frames) {
        size_t take;
        if (p->pendingPos >= p->pendingLen) {
            p->pendingPos = p->pendingLen = 0;
            if (!render_block(p)) break;
            p->pendingLen = TRACKER_CHUNK;
        }
        take = (size_t)(p->pendingLen - p->pendingPos);
        if (take > frames - done) take = frames - done;
        memcpy(out + done * 2, p->out + p->pendingPos * 2, take * 2 * sizeof(float));
        p->pendingPos += (int)take;
        done += take;
        real += take;
    }
    if (done < frames) memset(out + done * 2, 0, (frames - done) * 2 * sizeof(float));
    return real;
}

static int16_t to_s16(float v)
{
    double d = v < -1.0f ? -1.0 : v > 1.0f ? 1.0 : (double)v;
    return (int16_t)js_round(d * 32767);
}

size_t taud_render_s16(TaudPlayer *p, int16_t *out, size_t frames)
{
    float tmp[256 * 2];
    size_t done = 0, real = 0;
    while (done < frames) {
        size_t n = frames - done, k, got;
        if (n > 256) n = 256;
        got = taud_render(p, tmp, n);
        for (k = 0; k < n * 2; k++) out[done * 2 + k] = to_s16(tmp[k]);
        real += got;
        done += n;
    }
    return real;
}

/* ── WAV ── */

static void wr16(uint8_t *b, unsigned v) { b[0] = (uint8_t)v; b[1] = (uint8_t)(v >> 8); }
static void wr32(uint8_t *b, uint32_t v) { wr16(b, v & 0xffff); wr16(b + 2, v >> 16); }

/* The clean WAV's 16-bit quantiser (dither.js in the JS library): clamp,
 * scale by 32767, add a triangular -1…+1 LSB, round. The two draws are
 * separate statements because C leaves the order of a - b's operands open. */
static int16_t dither_s16(uint32_t *xs, float v)
{
    double d = v < -1.0f ? -1.0 : v > 1.0f ? 1.0 : (double)v;
    double a = (double)(te_xorshift32(xs) & 0xffffff);
    double b = (double)(te_xorshift32(xs) & 0xffffff);
    double q = js_round(d * 32767 + (a - b) / 16777216.0);
    return (int16_t)(q < -32768 ? -32768 : q > 32767 ? 32767 : q);
}

uint8_t *taud_encode_wav_quality(const float *interleaved, size_t frames, int src_rate, int dst_rate,
                                 TaudWavQuality quality, size_t *out_len)
{
    const float *pcm = interleaved;
    float *resampled = NULL;
    const int gritty = quality == TAUD_WAV_GRITTY;
    const unsigned bytesPer = gritty ? 1 : 2;
    size_t outFrames = frames, numSamples, dataBytes, i;
    uint32_t xs = TE_XORSHIFT_SEED;
    uint8_t *buf;
    if (src_rate != dst_rate) {
        resampled = te_resample_interleaved(interleaved, frames, 2, src_rate, dst_rate, &outFrames);
        if (resampled == NULL) return NULL;
        pcm = resampled;
    }
    numSamples = outFrames * 2;
    dataBytes = numSamples * bytesPer;
    buf = (uint8_t *)malloc(44 + dataBytes);
    if (buf == NULL) { free(resampled); return NULL; }
    memcpy(buf, "RIFF", 4);
    wr32(buf + 4, (uint32_t)(36 + dataBytes));
    memcpy(buf + 8, "WAVE", 4);
    memcpy(buf + 12, "fmt ", 4);
    wr32(buf + 16, 16);
    wr16(buf + 20, 1);
    wr16(buf + 22, 2);
    wr32(buf + 24, (uint32_t)dst_rate);
    wr32(buf + 28, (uint32_t)dst_rate * 2 * bytesPer);
    wr16(buf + 32, 2 * bytesPer);
    wr16(buf + 34, 8 * bytesPer);
    memcpy(buf + 36, "data", 4);
    wr32(buf + 40, (uint32_t)dataBytes);
    if (gritty) {
        /* The device's own dither, from a fresh state, a block at a time: at
         * the engine's rate these are the bytes taud_render_chunk_u8 gives. */
        float l[256], r[256], err[4] = { 0, 0, 0, 0 };
        size_t f0, k;
        for (f0 = 0; f0 < outFrames; f0 += 256) {
            size_t n = outFrames - f0 < 256 ? outFrames - f0 : 256;
            for (k = 0; k < n; k++) {
                l[k] = pcm[(f0 + k) * 2];
                r[k] = pcm[(f0 + k) * 2 + 1];
            }
            te_dither_u8(&xs, err, l, r, n, buf + 44 + f0 * 2);
        }
    } else {
        for (i = 0; i < numSamples; i++) wr16(buf + 44 + i * 2, (uint16_t)dither_s16(&xs, pcm[i]));
    }
    free(resampled);
    *out_len = 44 + dataBytes;
    return buf;
}

uint8_t *taud_encode_wav(const float *interleaved, size_t frames, int src_rate, int dst_rate, size_t *out_len)
{
    return taud_encode_wav_quality(interleaved, frames, src_rate, dst_rate, TAUD_WAV_CLEAN, out_len);
}
