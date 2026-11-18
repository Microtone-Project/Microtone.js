/* A WASAPI output, in C (COM through its C interface), with the three ways
 * Windows lets a program play:
 *
 *   SHARED              through the system mixer, at its rate, with its period
 *                       (usually 10 ms)
 *   SHARED_LOW_LATENCY  through the mixer, at a shorter period the driver
 *                       allows (Windows 10's IAudioClient3; the inbox HD Audio
 *                       driver goes down to about 3 ms)
 *   EXCLUSIVE           the device to ourselves: our rate, our period, the
 *                       sample format the hardware takes, no mixer between
 *
 * Event-driven, on a thread of its own registered with MMCSS as "Pro Audio".
 * Everything COM about a stream — activation, initialisation, rendering,
 * release — happens on that thread, so the caller's apartment (Qt's GUI
 * thread is single-threaded) never meets it. Devices are named by their
 * endpoint ids, which stay the same from one session to the next.
 *
 * desktop-qt/src/nativeaudio.cpp drives it; on other systems a stand-in with
 * the same functions (wasapi_fake.c, built with MICROTONE_FAKE_WASAPI) lets the
 * host and the Settings tab be exercised without Windows. */
#ifndef MICROTONE_WASAPI_H
#define MICROTONE_WASAPI_H

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    MT_WASAPI_SHARED = 0,
    MT_WASAPI_SHARED_LOW_LATENCY = 1,
    MT_WASAPI_EXCLUSIVE = 2
} MtWasapiMode;

#define MT_WASAPI_MAX_RATES 8

/** One output device, and what each mode can do with it. A frame count of 0
 *  means the mode is not available on it. */
typedef struct MtWasapiDevice {
    char id[512];    /* endpoint id, UTF-8 */
    char name[256];  /* friendly name, UTF-8 */
    int isDefault;
    int mixRate, mixChannels;
    /* SHARED: the mixer's period */
    int sharedPeriod;
    /* SHARED_LOW_LATENCY: periods are multiples of `llStep` in [llMin, llMax] */
    int llMin, llMax, llStep, llDefault;
    /* EXCLUSIVE: the shortest period, and the rates the hardware takes */
    int exMin;
    int exRates[MT_WASAPI_MAX_RATES];
    int exRateCount;
} MtWasapiDevice;

/** The render output devices; *out is malloc'd (free with mt_wasapi_free_list).
 *  Returns how many, or -1 when WASAPI is not there. */
int mt_wasapi_list(MtWasapiDevice **out);
void mt_wasapi_free_list(MtWasapiDevice *list);

/** Called on the stream's thread for `frames` frames of interleaved stereo
 *  float: the device's other channels are given silence. */
typedef void (*MtWasapiRender)(void *user, float *out, int frames);

typedef struct MtWasapiInfo {
    int rate;
    int channels;
    int periodFrames;   /* how many frames each wake-up asks for, typically */
    int bufferFrames;   /* the device buffer */
    double latencyMs;   /* buffer + the stream latency WASAPI reports */
    char format[48];    /* e.g. "32-bit float", "24-bit PCM in 32" */
    int mmcss;          /* the thread got "Pro Audio" */
    char name[256];     /* the device's friendly name, UTF-8 */
    int tries;          /* EXCLUSIVE: how many period/format pairs were tried */
} MtWasapiInfo;

typedef struct MtWasapiStream MtWasapiStream;

/** Open and start. `deviceId` NULL or "" = the default output. `rate` counts
 *  only in EXCLUSIVE mode (0 = the mixer's); the shared modes run at the
 *  mixer's. `periodFrames` is what is asked for, rounded to what the mode
 *  allows; in EXCLUSIVE mode a period the driver refuses is followed by the
 *  same in whole milliseconds, its default period and its minimum, in each
 *  sample format it says it takes (many USB drivers open only at their
 *  default). `info->periodFrames` is what it got. NULL, with `error` said,
 *  on failure. */
MtWasapiStream *mt_wasapi_open(const char *deviceId, MtWasapiMode mode, int rate, int periodFrames,
                               MtWasapiRender render, void *user, MtWasapiInfo *info,
                               char *error, int errorCap);

/** Stop and release; waits for the thread. */
void mt_wasapi_close(MtWasapiStream *s);

/** Wake-ups that found the buffer already empty (shared modes), and waits
 *  of two seconds with no wake-up at all (the device went away). */
unsigned mt_wasapi_glitches(const MtWasapiStream *s);
int mt_wasapi_lost(const MtWasapiStream *s);

#ifdef __cplusplus
}
#endif

#endif
