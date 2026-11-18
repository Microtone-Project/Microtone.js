/* wasapi-probe — what WASAPI offers on this machine, and a test tone through
 * each of the three modes (desktop-qt/src/wasapi.c, the backend the app uses).
 *
 *   wasapi-probe                  list the output devices
 *   wasapi-probe all [frames]     …and play 2 s of 440 Hz in each mode
 *   wasapi-probe shared|low|exclusive [frames] [rate] [device id]
 *
 * For each mode it says what the stream became (rate, period, buffer, sample
 * format, MMCSS) and how the callbacks arrived: how many, how many frames a
 * time, and the frames delivered per second against the rate.
 * Build (MinGW): x86_64-w64-mingw32-gcc -O2 -o wasapi-probe.exe
 *                tools/wasapi-probe.c src/wasapi.c -lole32 -lm */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

#include "../src/wasapi.h"

typedef struct {
    double phase, inc;
    volatile long frames, calls;
    int minFrames, maxFrames;
} Tone;

static void render(void *user, float *out, int n)
{
    Tone *t = (Tone *)user;
    int i;
    for (i = 0; i < n; i++) {
        const float v = (float)(0.2 * sin(t->phase));
        out[i * 2] = out[i * 2 + 1] = v;
        t->phase += t->inc;
        if (t->phase > 6.283185307179586) t->phase -= 6.283185307179586;
    }
    t->frames += n;
    t->calls++;
    if (t->minFrames == 0 || n < t->minFrames) t->minFrames = n;
    if (n > t->maxFrames) t->maxFrames = n;
}

static const char *MODE_NAMES[] = {"shared", "shared, low latency", "exclusive"};

static void play(const char *device, MtWasapiMode mode, int frames, int rate)
{
    Tone t;
    MtWasapiInfo info;
    char error[256] = "";
    LARGE_INTEGER f0, f1, freq;
    MtWasapiStream *s;
    double seconds;
    memset(&t, 0, sizeof t);
    t.inc = 2.0 * 3.141592653589793 * 440.0 / 48000.0;
    s = mt_wasapi_open(device, mode, rate, frames, render, &t, &info, error, sizeof error);
    printf("\n%s, asked for %d frames%s:\n", MODE_NAMES[mode], frames, mode == MT_WASAPI_EXCLUSIVE && rate ? " at that rate" : "");
    if (s == NULL) {
        printf("  refused: %s\n", error);
        return;
    }
    t.inc = 2.0 * 3.141592653589793 * 440.0 / info.rate;
    printf("  %d Hz, %d channels, %s; period %d frames (%.2f ms), buffer %d, latency %.2f ms; MMCSS %s\n",
           info.rate, info.channels, info.format, info.periodFrames, info.periodFrames * 1000.0 / info.rate,
           info.bufferFrames, info.latencyMs, info.mmcss ? "yes" : "no");
    QueryPerformanceFrequency(&freq);
    Sleep(300);  /* past the start-up */
    {
        const long c0 = t.calls, n0 = t.frames;
        QueryPerformanceCounter(&f0);
        Sleep(2000);
        QueryPerformanceCounter(&f1);
        seconds = (double)(f1.QuadPart - f0.QuadPart) / freq.QuadPart;
        printf("  %ld callbacks in %.2f s, %d…%d frames each; %.0f frames/s (rate %d); glitches %u\n",
               t.calls - c0, seconds, t.minFrames, t.maxFrames, (t.frames - n0) / seconds, info.rate,
               mt_wasapi_glitches(s));
    }
    mt_wasapi_close(s);
}

int main(int argc, char **argv)
{
    MtWasapiDevice *list = NULL;
    const int n = mt_wasapi_list(&list);
    const char *what = argc > 1 ? argv[1] : "";
    const int frames = argc > 2 ? atoi(argv[2]) : 128;
    const int rate = argc > 3 ? atoi(argv[3]) : 0;
    const char *device = argc > 4 ? argv[4] : NULL;
    int i, k;
    if (n < 0) {
        printf("WASAPI is not available\n");
        return 1;
    }
    printf("%d output device(s):\n", n);
    for (i = 0; i < n; i++) {
        const MtWasapiDevice *d = &list[i];
        printf("%s %s\n    id %s\n    mixer %d Hz, %d channels; shared period %d frames\n",
               d->isDefault ? "*" : "-", d->name, d->id, d->mixRate, d->mixChannels, d->sharedPeriod);
        if (d->llStep > 0)
            printf("    low latency: %d…%d frames in steps of %d (default %d)\n", d->llMin, d->llMax, d->llStep, d->llDefault);
        else
            printf("    low latency: not offered\n");
        printf("    exclusive: ");
        if (d->exRateCount == 0) printf("not offered\n");
        else {
            for (k = 0; k < d->exRateCount; k++) printf("%s%d", k ? ", " : "", d->exRates[k]);
            printf(" Hz, period from %d frames\n", d->exMin);
        }
    }
    mt_wasapi_free_list(list);
    if (!strcmp(what, "all") || !strcmp(what, "shared")) play(device, MT_WASAPI_SHARED, frames, 0);
    if (!strcmp(what, "all") || !strcmp(what, "low")) play(device, MT_WASAPI_SHARED_LOW_LATENCY, frames, 0);
    if (!strcmp(what, "all") || !strcmp(what, "exclusive")) play(device, MT_WASAPI_EXCLUSIVE, frames, rate);
    return 0;
}
