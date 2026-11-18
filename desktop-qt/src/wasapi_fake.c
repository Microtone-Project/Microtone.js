/* A stand-in for wasapi.c on systems without Windows: the same functions,
 * two made-up devices with the kinds of limits real ones report, and a thread
 * that asks for frames once a period, as WASAPI's event would, and drops
 * them. Built only with MICROTONE_FAKE_WASAPI, to try the host's WASAPI glue
 * and the Settings tab's modes without Windows; never shipped. (The real
 * backend is tried under Wine with tools/wasapi-probe.c.)
 *
 * MICROTONE_FAKE_WASAPI_LOSE_AFTER=<seconds>: the first stream opened goes
 * away after that long, as an unplugged device's does (its thread stops and
 * mt_wasapi_lost says so), for the host's reopen. */
#define _POSIX_C_SOURCE 200809L
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "wasapi.h"

static const MtWasapiDevice DEVICES[] = {
    {"{0.0.0.00000000}.{fake-speakers}", "Speakers (Fake HD Audio)", 1, 48000, 2, 480,
     128, 480, 32, 480, 96, {44100, 48000, 96000}, 3},
    {"{0.0.0.00000000}.{fake-usb-dac}", "Headphones (Fake USB DAC)", 0, 44100, 2, 441,
     0, 0, 0, 0, 64, {44100, 48000, 88200, 96000, 176400, 192000}, 6},
};
#define N_DEVICES ((int)(sizeof DEVICES / sizeof DEVICES[0]))

int mt_wasapi_list(MtWasapiDevice **out)
{
    *out = (MtWasapiDevice *)malloc(sizeof DEVICES);
    if (*out == NULL) return -1;
    memcpy(*out, DEVICES, sizeof DEVICES);
    return N_DEVICES;
}

void mt_wasapi_free_list(MtWasapiDevice *list) { free(list); }

struct MtWasapiStream {
    pthread_t thread;
    atomic_int stop;
    atomic_int lost;
    long loseAfterPeriods;  /* 0: never */
    atomic_uint glitches;
    int period, rate;
    MtWasapiRender render;
    void *user;
    float *scratch;
};

static void *run(void *arg)
{
    MtWasapiStream *s = (MtWasapiStream *)arg;
    struct timespec next;
    const long periodNs = (long)(1e9 * s->period / s->rate);
    long periods = 0;
    clock_gettime(CLOCK_MONOTONIC, &next);
    while (!atomic_load(&s->stop)) {
        if (s->loseAfterPeriods > 0 && ++periods > s->loseAfterPeriods) {
            atomic_store(&s->lost, 1);
            break;
        }
        next.tv_nsec += periodNs;
        while (next.tv_nsec >= 1000000000L) { next.tv_nsec -= 1000000000L; next.tv_sec++; }
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
        s->render(s->user, s->scratch, s->period);
    }
    return NULL;
}

MtWasapiStream *mt_wasapi_open(const char *deviceId, MtWasapiMode mode, int rate, int periodFrames,
                               MtWasapiRender render, void *user, MtWasapiInfo *info, char *error, int errorCap)
{
    const MtWasapiDevice *d = &DEVICES[0];
    MtWasapiStream *s;
    int i, period, buffer;
    const char *format = "32-bit float";
    for (i = 0; i < N_DEVICES; i++) {
        if (deviceId != NULL && deviceId[0] && strcmp(deviceId, DEVICES[i].id) == 0) d = &DEVICES[i];
    }
    if (mode == MT_WASAPI_SHARED) {
        rate = d->mixRate;
        period = d->sharedPeriod;
        buffer = periodFrames > 3 * period ? periodFrames : 3 * period;
    } else if (mode == MT_WASAPI_SHARED_LOW_LATENCY) {
        if (d->llStep == 0) {
            snprintf(error, (size_t)errorCap, "low-latency shared mode needs Windows 10 (IAudioClient3) (0x80004002)");
            return NULL;
        }
        rate = d->mixRate;
        period = periodFrames > 0 ? (periodFrames + d->llStep / 2) / d->llStep * d->llStep : d->llMin;
        if (period < d->llMin) period = d->llMin;
        if (period > d->llMax) period = d->llMax;
        buffer = 2 * period;
    } else {
        int ok = 0;
        if (rate == 0) rate = d->mixRate;
        for (i = 0; i < d->exRateCount; i++) ok |= d->exRates[i] == rate;
        if (!ok) {
            snprintf(error, (size_t)errorCap, "the device takes no stereo format at that rate exclusively (0x88890008)");
            return NULL;
        }
        period = periodFrames > d->exMin ? periodFrames : d->exMin;
        buffer = period;
        format = "24-bit PCM in 32";
    }
    s = (MtWasapiStream *)calloc(1, sizeof *s);
    if (s == NULL) return NULL;
    s->period = period;
    s->rate = rate;
    {
        static int opened = 0;
        const char *lose = getenv("MICROTONE_FAKE_WASAPI_LOSE_AFTER");
        if (opened++ == 0 && lose != NULL && atof(lose) > 0) s->loseAfterPeriods = (long)(atof(lose) * rate / period);
    }
    s->render = render;
    s->user = user;
    s->scratch = (float *)calloc((size_t)period * 2, sizeof(float));
    if (info != NULL) {
        memset(info, 0, sizeof *info);
        info->rate = rate;
        info->channels = 2;
        info->periodFrames = period;
        info->bufferFrames = buffer;
        info->latencyMs = buffer * 1000.0 / rate;
        snprintf(info->format, sizeof info->format, "%s", format);
        snprintf(info->name, sizeof info->name, "%s", d->name);
        info->mmcss = 1;
    }
    if (s->scratch == NULL || pthread_create(&s->thread, NULL, run, s) != 0) {
        free(s->scratch);
        free(s);
        snprintf(error, (size_t)errorCap, "no thread");
        return NULL;
    }
    return s;
}

void mt_wasapi_close(MtWasapiStream *s)
{
    if (s == NULL) return;
    atomic_store(&s->stop, 1);
    pthread_join(s->thread, NULL);
    free(s->scratch);
    free(s);
}

unsigned mt_wasapi_glitches(const MtWasapiStream *s) { return s != NULL ? atomic_load(&((MtWasapiStream *)s)->glitches) : 0; }
int mt_wasapi_lost(const MtWasapiStream *s) { return s != NULL && atomic_load(&((MtWasapiStream *)s)->lost) != 0; }
