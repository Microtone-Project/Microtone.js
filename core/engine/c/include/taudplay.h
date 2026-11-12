/*
 * taudplay — a portable, embeddable .taud replayer.
 *
 * The C twin of the `taudplay` JavaScript library (the playback half of the
 * Microtone tracker): the same engine, note for note, with the same small
 * surface — a transport, one fader per lane, two probes per lane, and the
 * sixteen interrupts a song can fire at the program playing it.
 *
 *     TaudPlayer *p = taud_open(bytes, len, NULL, NULL);
 *     taud_play(p);
 *     const float *block;
 *     while ((block = taud_render_chunk(p)) != NULL) {
 *         // TAUD_CHUNK frames of interleaved stereo float
 *     }
 *     taud_close(p);
 *
 * Pure C99, no dependencies beyond libm, no global state: any number of
 * players may run side by side, each on its own thread. Nothing on the render
 * path touches the heap except, rarely, the voice pool growing to fit a note
 * storm it has never seen before.
 *
 * Copyright (C) 2026 CuriousTorvald. Licensed under the GNU Lesser General
 * Public License version 3 or later — see COPYING.LESSER.
 */
#ifndef TAUDPLAY_H
#define TAUDPLAY_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TAUDPLAY_VERSION "2.60.1"

/** Frames per rendered block. Tick and row timing are per SAMPLE, so this is
 *  pure batching granularity and never changes what a song sounds like. */
#define TAUD_CHUNK 128

/** The engine's reference output rate; a render at this rate is bit-for-bit
 *  what the JavaScript library renders. */
#define TAUD_DEFAULT_RATE 48000

/** Lanes a song can have (32 or 64), and interrupts it can fire. */
#define TAUD_MAX_VOICES 64
#define TAUD_NUM_INTERRUPTS 16

typedef struct TaudPlayer TaudPlayer;

typedef enum {
    TAUD_OK = 0,
    TAUD_ERR_NOMEM,        /* an allocation failed */
    TAUD_ERR_FORMAT,       /* not a Taud container, or a malformed one */
    TAUD_ERR_NOT_A_SONG,   /* a .tsii / .tpif: valid, but no song to play */
    TAUD_ERR_DECOMPRESS,   /* a compressed section did not decode */
    TAUD_ERR_RANGE         /* song index out of range */
} TaudError;

/** A uniform [0,1) source. The engine draws from it for an instrument's
 *  volume/pan swing, the random LFO shape and the randomised sample effects. */
typedef double (*TaudRandomFn)(void *user);

/** An interrupt handler: `arg` is the 0…65535 the song's `:` named on the
 *  marker row (0 when it named none). */
typedef void (*TaudInterruptFn)(int n, unsigned arg, void *user);

typedef struct {
    int sample_rate;        /* engine output rate; 0 = TAUD_DEFAULT_RATE */
    int song_index;         /* which song of the file to load */
    int binaural;           /* run a SURROUND song through the head model */
    uint32_t random_seed;   /* seed of the built-in generator (mulberry32) */
    TaudRandomFn random;    /* NULL = the built-in seeded generator */
    void *random_user;
} TaudConfig;

typedef struct {
    int index;
    const char *name;       /* the song's own name, or "" */
    int patterns;
    int bpm;
    int channels;           /* lane count stored in the song table */
    int surround;           /* non-zero for a planar or spatial song */
} TaudSongInfo;

/* ── lifetime ─────────────────────────────────────────────────────────────── */

/** Fill `cfg` with the defaults (48 kHz, song 0, fold-down, seed 1). */
void taud_config_init(TaudConfig *cfg);

/** Parse a full .taud file and load a song. The bytes are only read during
 *  the call. `cfg` may be NULL. Returns NULL on failure, with `*err` set. */
TaudPlayer *taud_open(const void *bytes, size_t len, const TaudConfig *cfg, TaudError *err);
void taud_close(TaudPlayer *p);

const char *taud_error_string(TaudError err);

/* ── the file ─────────────────────────────────────────────────────────────── */

const char *taud_title(const TaudPlayer *p);      /* NULL when the file has none */
int taud_song_count(const TaudPlayer *p);
int taud_song_info(const TaudPlayer *p, int index, TaudSongInfo *out);
TaudError taud_select_song(TaudPlayer *p, int index);
int taud_current_song(const TaudPlayer *p);
int taud_sample_rate(const TaudPlayer *p);

/* ── transport ────────────────────────────────────────────────────────────── */

void taud_play(TaudPlayer *p);                    /* from the top */
void taud_stop(TaudPlayer *p);
void taud_seek_cue(TaudPlayer *p, int cue);
void taud_set_volume(TaudPlayer *p, double gain); /* master, 0…1 */
void taud_set_binaural(TaudPlayer *p, int on);    /* surround songs only */

int taud_is_playing(const TaudPlayer *p);
int taud_cue(const TaudPlayer *p);
int taud_row(const TaudPlayer *p);
int taud_bpm(const TaudPlayer *p);
int taud_speed(const TaudPlayer *p);
int taud_channel_count(const TaudPlayer *p);

/* ── the knob: one fader per lane ─────────────────────────────────────────── */

/** Lane `v` to `gain` (1 = as written, 0 = silent), faded there over
 *  `fade_seconds` of RENDERED time. */
void taud_set_voice_gain(TaudPlayer *p, int v, double gain, double fade_seconds);
double taud_get_voice_gain(const TaudPlayer *p, int v);

/* ── the probes: two per lane ─────────────────────────────────────────────── */

double taud_get_voice_volume(const TaudPlayer *p, int v); /* 0…1 */
double taud_get_voice_pan(const TaudPlayer *p, int v);    /* 0 left … 0.5 … 1 right */

/* ── interrupts: the song calling out ─────────────────────────────────────── */

/** Register (fn != NULL) or unregister interrupt `n` (0…15). Handlers run on
 *  the rendering thread, from taud_render_chunk, once per block the interrupt
 *  fired in — edge-triggered, lowest number first. */
void taud_set_interrupt(TaudPlayer *p, int n, TaudInterruptFn fn, void *user);
void taud_clear_interrupts(TaudPlayer *p);

/* ── rendering ────────────────────────────────────────────────────────────── */

/** Render one block. Returns TAUD_CHUNK frames of interleaved stereo float,
 *  valid until the next call, or NULL once the song has halted. */
const float *taud_render_chunk(TaudPlayer *p);

/** Pull exactly `frames` frames of interleaved stereo float into `out`,
 *  buffering across block boundaries — the shape an audio callback wants.
 *  Frames past the end of the song are silence. Returns the frames that were
 *  real song (< frames once it has halted). */
size_t taud_render(TaudPlayer *p, float *out, size_t frames);

/** Pull `frames` frames as interleaved stereo signed 16-bit, clamped and
 *  rounded (round(x × 32767), no dither — the clean WAV writer adds one).
 *  Returns as taud_render. */
size_t taud_render_s16(TaudPlayer *p, int16_t *out, size_t frames);

/** Render one block as the Taud device does: noise-shaped, dithered unsigned
 *  8-bit, interleaved stereo (2 × TAUD_CHUNK bytes). NULL once halted. */
const uint8_t *taud_render_chunk_u8(TaudPlayer *p);

/* ── utilities ────────────────────────────────────────────────────────────── */

/** How a WAV is quantised. CLEAN is 16-bit with a plain TPDF dither of one
 *  LSB; GRITTY is 8-bit through the device's own noise-shaped dither, which at
 *  the engine's rate is byte for byte what taud_render_chunk_u8 delivers. Both
 *  dithers start afresh, so one input always makes one file. */
typedef enum { TAUD_WAV_CLEAN = 0, TAUD_WAV_GRITTY = 1 } TaudWavQuality;

/** Encode interleaved stereo float at `src_rate` as a stereo WAV at
 *  `dst_rate` (Kaiser-windowed-sinc resampled when they differ), quantised as
 *  `quality` says. Returns a malloc'd buffer the caller frees, with its size
 *  in `*out_len`. Byte for byte the JS library's encodeWav. */
uint8_t *taud_encode_wav_quality(const float *interleaved, size_t frames, int src_rate,
                                 int dst_rate, TaudWavQuality quality, size_t *out_len);

/** taud_encode_wav_quality with TAUD_WAV_CLEAN. */
uint8_t *taud_encode_wav(const float *interleaved, size_t frames, int src_rate,
                         int dst_rate, size_t *out_len);

/** Gain (0…1) ↔ the engine's 0…255 attenuation byte. */
int taud_gain_to_fader(double gain);
double taud_fader_to_gain(int fader);

#ifdef __cplusplus
}
#endif
#endif /* TAUDPLAY_H */
