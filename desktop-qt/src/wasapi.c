/* WASAPI output — see wasapi.h. */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <propidl.h>
#include <mmreg.h>

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "wasapi.h"

/* The interfaces' ids, our own copies: a C program has no __uuidof, and which
 * library defines the IID_ symbols differs between toolchains. */
static const CLSID MT_CLSID_MMDeviceEnumerator =
    {0xbcde0395, 0xe52f, 0x467c, {0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e}};
static const IID MT_IID_IMMDeviceEnumerator =
    {0xa95664d2, 0x9614, 0x4f35, {0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6}};
static const IID MT_IID_IAudioClient =
    {0x1cb9ad4c, 0xdbfa, 0x4c32, {0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2}};
static const IID MT_IID_IAudioClient3 =
    {0x7ed4ee07, 0x8e67, 0x4cd4, {0x8c, 0x1a, 0x2b, 0x7a, 0x59, 0x87, 0xad, 0x42}};
static const IID MT_IID_IAudioRenderClient =
    {0xf294acfc, 0x3146, 0x4483, {0xa7, 0xbf, 0xad, 0xdc, 0xa7, 0xc2, 0x60, 0xe2}};
static const GUID MT_SUBTYPE_PCM =
    {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
static const GUID MT_SUBTYPE_FLOAT =
    {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
static const PROPERTYKEY MT_PKEY_Device_FriendlyName =
    {{0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};

#define HNS_PER_SECOND 10000000.0

static const int PROBE_RATES[] = {44100, 48000, 88200, 96000, 176400, 192000};

/* ── sample formats ── */

typedef enum { FMT_FLOAT32, FMT_PCM16, FMT_PCM24, FMT_PCM32_24, FMT_PCM32 } SampleKind;

static void make_format(WAVEFORMATEXTENSIBLE *f, int rate, int channels, SampleKind kind)
{
    int bits = kind == FMT_PCM16 ? 16 : kind == FMT_PCM24 ? 24 : 32;
    memset(f, 0, sizeof *f);
    f->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    f->Format.nChannels = (WORD)channels;
    f->Format.nSamplesPerSec = (DWORD)rate;
    f->Format.wBitsPerSample = (WORD)bits;
    f->Format.nBlockAlign = (WORD)(channels * bits / 8);
    f->Format.nAvgBytesPerSec = (DWORD)rate * f->Format.nBlockAlign;
    f->Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    f->Samples.wValidBitsPerSample = (WORD)(kind == FMT_PCM32_24 ? 24 : bits);
    f->dwChannelMask = channels == 2 ? (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT) : 0;
    f->SubFormat = kind == FMT_FLOAT32 ? MT_SUBTYPE_FLOAT : MT_SUBTYPE_PCM;
}

/** What a format the system gave us (the mixer's) holds, or -1. */
static int kind_of(const WAVEFORMATEX *f)
{
    int isFloat = f->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    int valid = f->wBitsPerSample;
    if (f->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        const WAVEFORMATEXTENSIBLE *x = (const WAVEFORMATEXTENSIBLE *)f;
        isFloat = IsEqualGUID(&x->SubFormat, &MT_SUBTYPE_FLOAT);
        if (!isFloat && !IsEqualGUID(&x->SubFormat, &MT_SUBTYPE_PCM)) return -1;
        if (x->Samples.wValidBitsPerSample) valid = x->Samples.wValidBitsPerSample;
    } else if (f->wFormatTag != WAVE_FORMAT_PCM && !isFloat) {
        return -1;
    }
    if (isFloat) return f->wBitsPerSample == 32 ? FMT_FLOAT32 : -1;
    switch (f->wBitsPerSample) {
    case 16: return FMT_PCM16;
    case 24: return FMT_PCM24;
    case 32: return valid == 24 ? FMT_PCM32_24 : FMT_PCM32;
    default: return -1;
    }
}

static const char *kind_name(int kind)
{
    switch (kind) {
    case FMT_FLOAT32: return "32-bit float";
    case FMT_PCM16: return "16-bit PCM";
    case FMT_PCM24: return "24-bit PCM";
    case FMT_PCM32_24: return "24-bit PCM in 32";
    case FMT_PCM32: return "32-bit PCM";
    default: return "?";
    }
}

static int frames_of(REFERENCE_TIME hns, int rate) { return (int)floor(hns * (double)rate / HNS_PER_SECOND + 0.5); }
static REFERENCE_TIME hns_of(int frames, int rate) { return (REFERENCE_TIME)floor(frames * HNS_PER_SECOND / rate + 0.5); }

static void utf8_of(const wchar_t *w, char *out, int cap)
{
    if (cap <= 0) return;
    out[0] = 0;
    if (w != NULL && WideCharToMultiByte(CP_UTF8, 0, w, -1, out, cap, NULL, NULL) == 0) out[cap - 1] = 0;
}

static void say(char *error, int cap, const char *what, HRESULT hr)
{
    if (error != NULL && cap > 0) snprintf(error, (size_t)cap, "%s (0x%08lx)", what, (unsigned long)hr);
}

/* COM on the calling thread: whatever it already is (Qt's GUI thread is
 * single-threaded), and undone only if we did it. */
static int com_enter(void)
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    return hr == S_OK || hr == S_FALSE;
}

static IMMDeviceEnumerator *enumerator(void)
{
    IMMDeviceEnumerator *e = NULL;
    if (FAILED(CoCreateInstance(&MT_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &MT_IID_IMMDeviceEnumerator,
                                (void **)&e))) {
        return NULL;
    }
    return e;
}

/** The device by endpoint id (UTF-8), or the default output. */
static IMMDevice *device_named(IMMDeviceEnumerator *e, const char *id)
{
    IMMDevice *d = NULL;
    if (id != NULL && id[0] != 0) {
        wchar_t wid[512];
        if (MultiByteToWideChar(CP_UTF8, 0, id, -1, wid, 512) > 0 && SUCCEEDED(IMMDeviceEnumerator_GetDevice(e, wid, &d)))
            return d;
    }
    if (FAILED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(e, eRender, eConsole, &d))) return NULL;
    return d;
}

/* ── the device list ── */

static void probe(IMMDevice *dev, MtWasapiDevice *out)
{
    IAudioClient *c = NULL;
    IAudioClient3 *c3 = NULL;
    WAVEFORMATEX *mix = NULL;
    REFERENCE_TIME defP = 0, minP = 0;
    int i;
    if (FAILED(IMMDevice_Activate(dev, &MT_IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&c))) return;
    if (SUCCEEDED(IAudioClient_GetMixFormat(c, &mix)) && mix != NULL) {
        out->mixRate = (int)mix->nSamplesPerSec;
        out->mixChannels = mix->nChannels;
    }
    if (SUCCEEDED(IAudioClient_GetDevicePeriod(c, &defP, &minP)) && out->mixRate > 0) {
        out->sharedPeriod = frames_of(defP, out->mixRate);
    }
    if (mix != NULL && SUCCEEDED(IAudioClient_QueryInterface(c, &MT_IID_IAudioClient3, (void **)&c3))) {
        UINT32 def = 0, step = 0, mn = 0, mx = 0;
        if (SUCCEEDED(IAudioClient3_GetSharedModeEnginePeriod(c3, mix, &def, &step, &mn, &mx)) && step > 0) {
            out->llDefault = (int)def;
            out->llStep = (int)step;
            out->llMin = (int)mn;
            out->llMax = (int)mx;
        }
        IAudioClient3_Release(c3);
    }
    /* Exclusive: the rates the hardware takes in any sample format we write. */
    for (i = 0; i < (int)(sizeof PROBE_RATES / sizeof PROBE_RATES[0]); i++) {
        int k, ok = 0;
        for (k = FMT_FLOAT32; k <= FMT_PCM32 && !ok; k++) {
            WAVEFORMATEXTENSIBLE f;
            make_format(&f, PROBE_RATES[i], 2, (SampleKind)k);
            ok = IAudioClient_IsFormatSupported(c, AUDCLNT_SHAREMODE_EXCLUSIVE, (WAVEFORMATEX *)&f, NULL) == S_OK;
        }
        if (ok && out->exRateCount < MT_WASAPI_MAX_RATES) out->exRates[out->exRateCount++] = PROBE_RATES[i];
    }
    if (out->exRateCount > 0 && minP > 0 && out->mixRate > 0) out->exMin = frames_of(minP, out->mixRate);
    if (mix != NULL) CoTaskMemFree(mix);
    IAudioClient_Release(c);
}

int mt_wasapi_list(MtWasapiDevice **out)
{
    int entered = com_enter(), n = -1;
    IMMDeviceEnumerator *e = enumerator();
    IMMDeviceCollection *all = NULL;
    IMMDevice *def = NULL;
    LPWSTR defId = NULL;
    UINT count = 0, i;
    *out = NULL;
    if (e == NULL) goto done;
    if (FAILED(IMMDeviceEnumerator_EnumAudioEndpoints(e, eRender, DEVICE_STATE_ACTIVE, &all))) goto done;
    if (FAILED(IMMDeviceCollection_GetCount(all, &count))) goto done;
    if (SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(e, eRender, eConsole, &def))) IMMDevice_GetId(def, &defId);
    *out = (MtWasapiDevice *)calloc(count ? count : 1, sizeof(MtWasapiDevice));
    if (*out == NULL) goto done;
    n = 0;
    for (i = 0; i < count; i++) {
        IMMDevice *d = NULL;
        IPropertyStore *props = NULL;
        LPWSTR id = NULL;
        MtWasapiDevice *m = &(*out)[n];
        if (FAILED(IMMDeviceCollection_Item(all, i, &d))) continue;
        if (SUCCEEDED(IMMDevice_GetId(d, &id))) {
            utf8_of(id, m->id, sizeof m->id);
            m->isDefault = defId != NULL && wcscmp(id, defId) == 0;
            CoTaskMemFree(id);
        }
        if (SUCCEEDED(IMMDevice_OpenPropertyStore(d, STGM_READ, &props))) {
            PROPVARIANT v;
            PropVariantInit(&v);
            if (SUCCEEDED(IPropertyStore_GetValue(props, &MT_PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR)
                utf8_of(v.pwszVal, m->name, sizeof m->name);
            PropVariantClear(&v);
            IPropertyStore_Release(props);
        }
        if (m->name[0] == 0) snprintf(m->name, sizeof m->name, "%s", m->id);
        probe(d, m);
        IMMDevice_Release(d);
        n++;
    }
done:
    if (defId != NULL) CoTaskMemFree(defId);
    if (def != NULL) IMMDevice_Release(def);
    if (all != NULL) IMMDeviceCollection_Release(all);
    if (e != NULL) IMMDeviceEnumerator_Release(e);
    if (entered) CoUninitialize();
    return n;
}

void mt_wasapi_free_list(MtWasapiDevice *list) { free(list); }

/* ── a stream ── */

struct MtWasapiStream {
    /* asked for */
    char deviceId[512];
    MtWasapiMode mode;
    int rate, periodFrames;
    MtWasapiRender render;
    void *user;
    /* the thread's */
    HANDLE thread, ready, stop, event;
    IAudioClient *client;
    IAudioRenderClient *rc;
    UINT32 bufferFrames;
    int kind, channels;
    float *scratch;      /* bufferFrames of stereo float */
    uint32_t dither;     /* xorshift32, for 16-bit output */
    volatile LONG glitches;
    volatile LONG lost;
    /* reported back once set up */
    int ok;
    MtWasapiInfo info;
    char error[256];
};

static float tpdf(MtWasapiStream *s)
{
    float a, b;
    uint32_t x = s->dither;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    a = (float)(x >> 8) / 16777216.0f;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    b = (float)(x >> 8) / 16777216.0f;
    s->dither = x;
    return a - b;  /* triangular, ±1 */
}

/** Stereo float into the device's buffer: its format, its channel count. */
static void write_out(MtWasapiStream *s, BYTE *dst, const float *src, int frames)
{
    const int ch = s->channels;
    int f, c;
    for (f = 0; f < frames; f++) {
        for (c = 0; c < ch; c++) {
            const double v = c < 2 ? src[f * 2 + c] : 0.0;
            const int at = f * ch + c;
            switch (s->kind) {
            case FMT_FLOAT32: ((float *)dst)[at] = (float)v; break;
            case FMT_PCM16: {
                double q = floor(v * 32767.0 + tpdf(s) + 0.5);
                if (q > 32767.0) q = 32767.0; else if (q < -32768.0) q = -32768.0;
                ((int16_t *)dst)[at] = (int16_t)q;
                break;
            }
            case FMT_PCM24: {
                double q = floor(v * 8388607.0 + 0.5);
                int32_t i;
                if (q > 8388607.0) q = 8388607.0; else if (q < -8388608.0) q = -8388608.0;
                i = (int32_t)q;
                dst[at * 3] = (BYTE)(i & 0xff);
                dst[at * 3 + 1] = (BYTE)((i >> 8) & 0xff);
                dst[at * 3 + 2] = (BYTE)((i >> 16) & 0xff);
                break;
            }
            case FMT_PCM32_24: {
                double q = floor(v * 8388607.0 + 0.5);
                if (q > 8388607.0) q = 8388607.0; else if (q < -8388608.0) q = -8388608.0;
                ((int32_t *)dst)[at] = (int32_t)((uint32_t)(int32_t)q << 8);
                break;
            }
            default: {
                double q = floor(v * 2147483647.0 + 0.5);
                if (q > 2147483647.0) q = 2147483647.0; else if (q < -2147483648.0) q = -2147483648.0;
                ((int32_t *)dst)[at] = (int32_t)q;
                break;
            }
            }
        }
    }
}

static void release_client(MtWasapiStream *s)
{
    if (s->rc != NULL) { IAudioRenderClient_Release(s->rc); s->rc = NULL; }
    if (s->client != NULL) { IAudioClient_Release(s->client); s->client = NULL; }
}

/** Activate and initialise for the mode; on the stream's thread. */
static int setup(MtWasapiStream *s)
{
    IMMDeviceEnumerator *e = enumerator();
    IMMDevice *dev = NULL;
    WAVEFORMATEX *mix = NULL;
    WAVEFORMATEXTENSIBLE ex;
    const WAVEFORMATEX *fmt = NULL;
    REFERENCE_TIME defP = 0, minP = 0, latency = 0;
    HRESULT hr;
    int ok = 0;

    if (e == NULL) { say(s->error, sizeof s->error, "WASAPI is not available", E_FAIL); return 0; }
    dev = device_named(e, s->deviceId);
    if (dev == NULL) { say(s->error, sizeof s->error, "no output device", E_FAIL); goto out; }
    hr = IMMDevice_Activate(dev, &MT_IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&s->client);
    if (FAILED(hr)) { say(s->error, sizeof s->error, "the device would not activate", hr); goto out; }
    hr = IAudioClient_GetMixFormat(s->client, &mix);
    if (FAILED(hr) || mix == NULL) { say(s->error, sizeof s->error, "no mix format", hr); goto out; }
    IAudioClient_GetDevicePeriod(s->client, &defP, &minP);

    if (s->mode == MT_WASAPI_EXCLUSIVE) {
        /* Our rate (the mixer's by default), the first sample format the
         * hardware takes, a period no shorter than its minimum — and if the
         * buffer that makes is not aligned, the size it says, once more. */
        const int rate = s->rate > 0 ? s->rate : (int)mix->nSamplesPerSec;
        int k, found = -1;
        REFERENCE_TIME period;
        for (k = FMT_FLOAT32; k <= FMT_PCM32 && found < 0; k++) {
            make_format(&ex, rate, 2, (SampleKind)k);
            if (IAudioClient_IsFormatSupported(s->client, AUDCLNT_SHAREMODE_EXCLUSIVE, (WAVEFORMATEX *)&ex, NULL) == S_OK)
                found = k;
        }
        if (found < 0) { say(s->error, sizeof s->error, "the device takes no stereo format at that rate exclusively", AUDCLNT_E_UNSUPPORTED_FORMAT); goto out; }
        make_format(&ex, rate, 2, (SampleKind)found);
        fmt = (const WAVEFORMATEX *)&ex;
        period = hns_of(s->periodFrames > 0 ? s->periodFrames : 0, rate);
        if (period < minP) period = minP;
        hr = IAudioClient_Initialize(s->client, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                     period, period, fmt, NULL);
        if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
            UINT32 n = 0;
            IAudioClient_GetBufferSize(s->client, &n);
            IAudioClient_Release(s->client);
            s->client = NULL;
            hr = IMMDevice_Activate(dev, &MT_IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&s->client);
            if (FAILED(hr)) { say(s->error, sizeof s->error, "the device would not activate again", hr); goto out; }
            period = hns_of((int)n, rate);
            hr = IAudioClient_Initialize(s->client, AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                         period, period, fmt, NULL);
        }
        if (FAILED(hr)) {
            say(s->error, sizeof s->error, hr == AUDCLNT_E_DEVICE_IN_USE ? "another program has the device"
                                         : "exclusive mode was refused", hr);
            goto out;
        }
        s->kind = found;
        s->channels = 2;
    } else if (s->mode == MT_WASAPI_SHARED_LOW_LATENCY) {
        /* The mixer's format, at a period of the driver's choosing: a
         * multiple of its step, between its minimum and maximum. */
        IAudioClient3 *c3 = NULL;
        UINT32 def = 0, step = 0, mn = 0, mx = 0, want;
        hr = IAudioClient_QueryInterface(s->client, &MT_IID_IAudioClient3, (void **)&c3);
        if (FAILED(hr)) { say(s->error, sizeof s->error, "low-latency shared mode needs Windows 10 (IAudioClient3)", hr); goto out; }
        hr = IAudioClient3_GetSharedModeEnginePeriod(c3, mix, &def, &step, &mn, &mx);
        if (FAILED(hr) || step == 0) {
            IAudioClient3_Release(c3);
            say(s->error, sizeof s->error, "the driver offers no shorter period", hr);
            goto out;
        }
        want = s->periodFrames > 0 ? (UINT32)s->periodFrames : mn;
        want = (want + step / 2) / step * step;
        if (want < mn) want = mn;
        if (want > mx) want = mx;
        hr = IAudioClient3_InitializeSharedAudioStream(c3, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, want, mix, NULL);
        if (hr == AUDCLNT_E_INVALID_DEVICE_PERIOD && want != def && def > 0) {
            /* A driver may refuse a period it listed (Wine refuses its own
             * minimum): its default always opens. The caller is told the
             * period it got. */
            IAudioClient3_Release(c3);
            c3 = NULL;
            IAudioClient_Release(s->client);
            s->client = NULL;
            hr = IMMDevice_Activate(dev, &MT_IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&s->client);
            if (SUCCEEDED(hr)) hr = IAudioClient_QueryInterface(s->client, &MT_IID_IAudioClient3, (void **)&c3);
            want = def;
            if (SUCCEEDED(hr)) hr = IAudioClient3_InitializeSharedAudioStream(c3, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, want, mix, NULL);
        }
        if (c3 != NULL) IAudioClient3_Release(c3);
        if (FAILED(hr)) { say(s->error, sizeof s->error, "the low-latency stream was refused", hr); goto out; }
        fmt = mix;
        s->kind = kind_of(mix);
        s->channels = mix->nChannels;
        s->info.periodFrames = (int)want;
    } else {
        /* Through the mixer: its format, its period; what is asked for is
         * the buffer behind it. */
        fmt = mix;
        hr = IAudioClient_Initialize(s->client, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                     hns_of(s->periodFrames > 0 ? s->periodFrames : 0, (int)mix->nSamplesPerSec),
                                     0, fmt, NULL);
        if (FAILED(hr)) { say(s->error, sizeof s->error, "the shared stream was refused", hr); goto out; }
        s->kind = kind_of(mix);
        s->channels = mix->nChannels;
        s->info.periodFrames = frames_of(defP, (int)mix->nSamplesPerSec);
    }
    if (s->kind < 0) { say(s->error, sizeof s->error, "the mixer's sample format is not one this writes", E_FAIL); goto out; }

    hr = IAudioClient_SetEventHandle(s->client, s->event);
    if (FAILED(hr)) { say(s->error, sizeof s->error, "no event handle", hr); goto out; }
    hr = IAudioClient_GetBufferSize(s->client, &s->bufferFrames);
    if (FAILED(hr)) { say(s->error, sizeof s->error, "no buffer size", hr); goto out; }
    hr = IAudioClient_GetService(s->client, &MT_IID_IAudioRenderClient, (void **)&s->rc);
    if (FAILED(hr)) { say(s->error, sizeof s->error, "no render client", hr); goto out; }
    s->scratch = (float *)calloc((size_t)s->bufferFrames * 2, sizeof(float));
    if (s->scratch == NULL) { say(s->error, sizeof s->error, "out of memory", E_OUTOFMEMORY); goto out; }

    /* Silence first: an exclusive stream must start with a full buffer. */
    {
        BYTE *data = NULL;
        if (SUCCEEDED(IAudioRenderClient_GetBuffer(s->rc, s->bufferFrames, &data)))
            IAudioRenderClient_ReleaseBuffer(s->rc, s->bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
    }
    IAudioClient_GetStreamLatency(s->client, &latency);
    s->info.rate = (int)fmt->nSamplesPerSec;
    s->info.channels = s->channels;
    s->info.bufferFrames = (int)s->bufferFrames;
    if (s->mode == MT_WASAPI_EXCLUSIVE) s->info.periodFrames = (int)s->bufferFrames;
    s->info.latencyMs = (s->bufferFrames * 1000.0) / fmt->nSamplesPerSec + latency / 10000.0;
    snprintf(s->info.format, sizeof s->info.format, "%s", kind_name(s->kind));
    ok = 1;
out:
    if (mix != NULL) CoTaskMemFree(mix);
    if (dev != NULL) IMMDevice_Release(dev);
    IMMDeviceEnumerator_Release(e);
    if (!ok) release_client(s);
    return ok;
}

typedef HANDLE(WINAPI *AvSetMmThreadCharacteristicsW_t)(LPCWSTR, LPDWORD);
typedef BOOL(WINAPI *AvRevertMmThreadCharacteristics_t)(HANDLE);

static DWORD WINAPI stream_thread(LPVOID arg)
{
    MtWasapiStream *s = (MtWasapiStream *)arg;
    HANDLE waits[2];
    HMODULE avrt;
    HANDLE task = NULL;
    AvRevertMmThreadCharacteristics_t revert = NULL;
    const int entered = SUCCEEDED(CoInitializeEx(NULL, COINIT_MULTITHREADED));

    /* "Pro Audio": the MMCSS class for low-latency audio — the thread runs
     * at real-time priority while it has work. */
    avrt = LoadLibraryW(L"avrt.dll");
    if (avrt != NULL) {
        AvSetMmThreadCharacteristicsW_t set =
            (AvSetMmThreadCharacteristicsW_t)(void (*)(void))GetProcAddress(avrt, "AvSetMmThreadCharacteristicsW");
        revert = (AvRevertMmThreadCharacteristics_t)(void (*)(void))GetProcAddress(avrt, "AvRevertMmThreadCharacteristics");
        DWORD index = 0;
        if (set != NULL) task = set(L"Pro Audio", &index);
    }
    s->info.mmcss = task != NULL;

    s->ok = setup(s);
    SetEvent(s->ready);
    if (!s->ok) goto done;
    if (FAILED(IAudioClient_Start(s->client))) { s->lost = 1; goto done; }

    waits[0] = s->stop;
    waits[1] = s->event;
    for (;;) {
        DWORD w = WaitForMultipleObjects(2, waits, FALSE, 2000);
        UINT32 n, padding = 0;
        BYTE *data = NULL;
        HRESULT hr;
        if (w == WAIT_OBJECT_0) break;
        if (w == WAIT_TIMEOUT) {  /* no wake-up for two seconds: the device has gone */
            InterlockedIncrement(&s->glitches);
            continue;
        }
        if (s->mode == MT_WASAPI_EXCLUSIVE) {
            n = s->bufferFrames;  /* each wake-up wants the whole buffer */
        } else {
            hr = IAudioClient_GetCurrentPadding(s->client, &padding);
            if (FAILED(hr)) { if (hr == AUDCLNT_E_DEVICE_INVALIDATED) { s->lost = 1; break; } continue; }
            if (padding == 0) InterlockedIncrement(&s->glitches);
            n = s->bufferFrames - padding;
        }
        if (n == 0) continue;
        hr = IAudioRenderClient_GetBuffer(s->rc, n, &data);
        if (FAILED(hr)) { if (hr == AUDCLNT_E_DEVICE_INVALIDATED) { s->lost = 1; break; } continue; }
        s->render(s->user, s->scratch, (int)n);
        write_out(s, data, s->scratch, (int)n);
        IAudioRenderClient_ReleaseBuffer(s->rc, n, 0);
    }
    IAudioClient_Stop(s->client);
done:
    release_client(s);
    if (task != NULL && revert != NULL) revert(task);
    if (avrt != NULL) FreeLibrary(avrt);
    if (entered) CoUninitialize();
    return 0;
}

MtWasapiStream *mt_wasapi_open(const char *deviceId, MtWasapiMode mode, int rate, int periodFrames,
                               MtWasapiRender render, void *user, MtWasapiInfo *info, char *error, int errorCap)
{
    MtWasapiStream *s = (MtWasapiStream *)calloc(1, sizeof *s);
    if (s == NULL) { say(error, errorCap, "out of memory", E_OUTOFMEMORY); return NULL; }
    if (deviceId != NULL) snprintf(s->deviceId, sizeof s->deviceId, "%s", deviceId);
    s->mode = mode;
    s->rate = rate;
    s->periodFrames = periodFrames;
    s->render = render;
    s->user = user;
    s->kind = -1;
    s->dither = 0x9e3779b9u;
    s->ready = CreateEventW(NULL, TRUE, FALSE, NULL);
    s->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    s->event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (s->ready == NULL || s->stop == NULL || s->event == NULL) {
        say(error, errorCap, "no events", HRESULT_FROM_WIN32(GetLastError()));
        mt_wasapi_close(s);
        return NULL;
    }
    s->thread = CreateThread(NULL, 0, stream_thread, s, 0, NULL);
    if (s->thread == NULL) {
        say(error, errorCap, "no thread", HRESULT_FROM_WIN32(GetLastError()));
        mt_wasapi_close(s);
        return NULL;
    }
    WaitForSingleObject(s->ready, INFINITE);
    if (!s->ok) {
        if (error != NULL && errorCap > 0) snprintf(error, (size_t)errorCap, "%s", s->error);
        mt_wasapi_close(s);
        return NULL;
    }
    if (info != NULL) *info = s->info;
    return s;
}

void mt_wasapi_close(MtWasapiStream *s)
{
    if (s == NULL) return;
    if (s->thread != NULL) {
        SetEvent(s->stop);
        WaitForSingleObject(s->thread, INFINITE);
        CloseHandle(s->thread);
    }
    if (s->ready != NULL) CloseHandle(s->ready);
    if (s->stop != NULL) CloseHandle(s->stop);
    if (s->event != NULL) CloseHandle(s->event);
    free(s->scratch);
    free(s);
}

unsigned mt_wasapi_glitches(const MtWasapiStream *s) { return s != NULL ? (unsigned)s->glitches : 0; }
int mt_wasapi_lost(const MtWasapiStream *s) { return s != NULL && s->lost != 0; }
