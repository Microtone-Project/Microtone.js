// asio-probe: the ASIO drivers on this machine as Microtone's audio host meets
// them — RtAudio's ASIO backend and the SDK files the app is built with — for
// when one will not play. Ships beside microtone.exe (CMakeLists.txt).
//
//   asio-probe                    every driver: its outputs, rates and sample
//                                 format, and the buffer sizes it allows
//   asio-probe <n> [rate] [frames]
//                                 a 440 Hz tone for three seconds through
//                                 driver n (frames 0 or none: the driver's own
//                                 size, as the app asks by default)
//   asio-probe all                the list, then that tone through each driver
//                                 the app may use, best first (src/asiotiers.h:
//                                 hardware, Steinberg's built-in, generic) — a
//                                 blocked one only when asked for by number
//   asio-probe panel <n>          driver n's own settings window
//   asio-probe check "<name>"     the app's check (src/asiocheck.cpp): that
//                                 driver ALONE — no other is loaded — opened,
//                                 a second of silence, closed; the exit code
//                                 says how it went (src/asiotiers.h
//                                 CheckExit), and a crash is the process's
//                                 own death, which the app reads as such
//
// A driver's sizes are only told while it is loaded, so the list opens each
// driver in turn, briefly, without playing.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include "RtAudio.h"
#include "../src/asiodriver.h"
#include "../src/asiotiers.h"

// RtAudio's ASIO driver filter (its patch 1: vendor/VENDOR-VERSIONS.md).
extern bool (*rtaudio_asio_driver_allowed)(const char *name);

namespace {

const char *formatName(RtAudioFormat f) {
  if (f & RTAUDIO_FLOAT32) return "32-bit float";
  if (f & RTAUDIO_FLOAT64) return "64-bit float";
  if (f & RTAUDIO_SINT32) return "32-bit PCM";
  if (f & RTAUDIO_SINT24) return "24-bit PCM";
  if (f & RTAUDIO_SINT16) return "16-bit PCM";
  return "unknown";
}

struct Tone {
  double phase = 0.0;
  double step = 0.0;
  std::atomic<unsigned> underflows{0};
  std::atomic<unsigned> calls{0};
};

int toneCallback(void *out, void *, unsigned int frames, double, RtAudioStreamStatus status, void *user) {
  Tone *t = static_cast<Tone *>(user);
  if (status & RTAUDIO_OUTPUT_UNDERFLOW) t->underflows++;
  t->calls++;
  float *o = static_cast<float *>(out);
  for (unsigned int n = 0; n < frames; n++) {
    const float v = float(0.2 * std::sin(t->phase));
    t->phase += t->step;
    if (t->phase > 6.283185307179586) t->phase -= 6.283185307179586;
    o[2 * n] = v;
    o[2 * n + 1] = v;
  }
  return 0;
}

int silence(void *out, void *, unsigned int frames, double, RtAudioStreamStatus, void *) {
  std::memset(out, 0, sizeof(float) * 2 * frames);
  return 0;
}

// check: the one driver RtAudio may load, and the callbacks it made.
std::string g_only;
bool onlyThatDriver(const char *name) { return g_only == name; }
std::atomic<unsigned> g_checkCalls{0};
int countedSilence(void *out, void *, unsigned int frames, double, RtAudioStreamStatus, void *) {
  std::memset(out, 0, sizeof(float) * 2 * frames);
  g_checkCalls++;
  return 0;
}

void printLimits() {
  microtone::asio::BufferLimits l;
  if (!microtone::asio::bufferLimits(&l)) {
    std::printf("    buffer sizes: the driver would not say\n");
    return;
  }
  const char *how = l.granularity == -1 ? "powers of two" : l.granularity == 0 ? "the preferred size only" : nullptr;
  if (how) {
    std::printf("    buffer sizes: %ld to %ld frames, %s; preferred %ld\n", l.min, l.max, how, l.preferred);
  } else {
    std::printf("    buffer sizes: %ld to %ld frames in steps of %ld; preferred %ld\n", l.min, l.max, l.granularity,
                l.preferred);
  }
}

/** Open driver `id` for stereo output: rate 0 = 48 kHz where it has it, else
 *  its preferred; frames 0 = its own size. */
bool openOutput(RtAudio &dac, unsigned int id, unsigned int rate, unsigned int *frames, RtAudioCallback cb,
                void *user) {
  const RtAudio::DeviceInfo info = dac.getDeviceInfo(id);
  if (rate == 0) {
    rate = info.preferredSampleRate;
    for (unsigned int r : info.sampleRates) {
      if (r == 48000) rate = 48000;
    }
  }
  RtAudio::StreamParameters p;
  p.deviceId = id;
  p.nChannels = 2;
  RtAudio::StreamOptions options;
  options.streamName = "Microtone asio-probe";
  if (dac.openStream(&p, nullptr, RTAUDIO_FLOAT32, rate, frames, cb, user, &options) != RTAUDIO_NO_ERROR) {
    std::printf("    would not open: %s\n", dac.getErrorText().c_str());
    return false;
  }
  return true;
}

int list(RtAudio &dac) {
  const std::vector<unsigned int> ids = dac.getDeviceIds();
  if (ids.empty()) {
    std::printf("No ASIO driver is installed.\n");
    return 0;
  }
  for (size_t i = 0; i < ids.size(); i++) {
    const RtAudio::DeviceInfo info = dac.getDeviceInfo(ids[i]);
    const microtone::asio::Tier tier = microtone::asio::tierOf(info.name);
    std::printf("[%zu] %s (%s)\n", i, info.name.c_str(), microtone::asio::tierName(tier));
    if (tier == microtone::asio::Tier::Blocked) continue;  // not even opened
    std::printf("    outputs: %u, inputs: %u; sample format: %s\n", info.outputChannels, info.inputChannels,
                formatName(info.nativeFormats));
    std::printf("    rates:");
    for (unsigned int r : info.sampleRates) std::printf(" %u", r);
    std::printf(" (preferred %u)\n", info.preferredSampleRate);
    if (info.outputChannels < 2) {
      std::printf("    fewer than two outputs: the app does not offer it\n");
      continue;
    }
    unsigned int frames = 0;
    if (!openOutput(dac, ids[i], 0, &frames, &silence, nullptr)) continue;
    printLimits();
    std::printf("    opened at %u Hz, %u frames; output latency %ld frames\n", dac.getStreamSampleRate(), frames,
                dac.getStreamLatency());
    dac.closeStream();
  }
  return 0;
}

int play(RtAudio &dac, size_t index, unsigned int rate, unsigned int frames) {
  const std::vector<unsigned int> ids = dac.getDeviceIds();
  if (index >= ids.size()) {
    std::printf("There is no driver %zu (asio-probe lists them).\n", index);
    return 1;
  }
  std::printf("%s\n", dac.getDeviceInfo(ids[index]).name.c_str());
  Tone tone;
  if (!openOutput(dac, ids[index], rate, &frames, &toneCallback, &tone)) return 1;
  tone.step = 2.0 * 3.141592653589793 * 440.0 / dac.getStreamSampleRate();
  printLimits();
  std::printf("    playing at %u Hz, %u frames (%.2f ms); output latency %ld frames\n", dac.getStreamSampleRate(),
              frames, frames * 1000.0 / dac.getStreamSampleRate(), dac.getStreamLatency());
  if (dac.startStream() != RTAUDIO_NO_ERROR) {
    std::printf("    would not start: %s\n", dac.getErrorText().c_str());
    dac.closeStream();
    return 1;
  }
  std::this_thread::sleep_for(std::chrono::seconds(3));
  dac.stopStream();
  dac.closeStream();
  std::printf("    %u callbacks, %u reported underflows\n", tone.calls.load(), tone.underflows.load());
  return tone.calls.load() > 0 ? 0 : 1;
}

int panel(RtAudio &dac, size_t index) {
  const std::vector<unsigned int> ids = dac.getDeviceIds();
  if (index >= ids.size()) {
    std::printf("There is no driver %zu (asio-probe lists them).\n", index);
    return 1;
  }
  unsigned int frames = 0;
  if (!openOutput(dac, ids[index], 0, &frames, &silence, nullptr)) return 1;
  if (!microtone::asio::controlPanel()) std::printf("The driver has no settings window.\n");
  std::printf("Press Enter when done.\n");
  std::getchar();
  if (dac.isStreamOpen()) dac.closeStream();
  return 0;
}

/** The app's check of one driver (the filter is set before anything is
 *  listed, so no other driver is loaded). Silence, never a tone: this runs
 *  when someone starts Microtone. */
int check(RtAudio &dac) {
  unsigned int id = 0;
  for (unsigned int candidate : dac.getDeviceIds()) {
    if (dac.getDeviceInfo(candidate).name == g_only) id = candidate;
  }
  if (id == 0) {
    std::printf("check: \"%s\" is not listed (it would not load, or not answer)\n", g_only.c_str());
    return microtone::asio::kCheckNotFound;
  }
  std::printf("check: \"%s\" loaded\n", g_only.c_str());
  unsigned int frames = 0;
  if (!openOutput(dac, id, 0, &frames, &countedSilence, nullptr)) return microtone::asio::kCheckUnopened;
  std::printf("check: opened at %u Hz, %u frames\n", dac.getStreamSampleRate(), frames);
  if (dac.startStream() != RTAUDIO_NO_ERROR) {
    std::printf("check: would not start: %s\n", dac.getErrorText().c_str());
    dac.closeStream();
    return microtone::asio::kCheckUnopened;
  }
  std::this_thread::sleep_for(std::chrono::seconds(1));
  if (dac.isStreamRunning()) dac.stopStream();
  if (dac.isStreamOpen()) dac.closeStream();
  const unsigned calls = g_checkCalls.load();
  std::printf("check: %u callbacks; stopped and closed\n", calls);
  return calls > 0 ? microtone::asio::kCheckOk : microtone::asio::kCheckQuiet;
}

}  // namespace

int main(int argc, char **argv) {
  // Unbuffered: written to a file (installer/diagnostics.cmd), a probe that
  // dies in a driver must leave everything up to that point.
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  RtAudio dac(RtAudio::WINDOWS_ASIO, [](RtAudioErrorType type, const std::string &text) {
    std::fprintf(stderr, "%s: %s\n", type == RTAUDIO_WARNING ? "warning" : "error", text.c_str());
  });
  if (dac.getCurrentApi() != RtAudio::WINDOWS_ASIO) {
    std::printf("This build has no ASIO.\n");
    return 1;
  }
  if (argc > 2 && std::strcmp(argv[1], "check") == 0) {
    g_only = argv[2];
    rtaudio_asio_driver_allowed = &onlyThatDriver;  // before anything is listed
    // A driver that crashes ends this process, and that is the answer: no
    // "has stopped working" box in front of the person starting Microtone.
    SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    return check(dac);
  }
  if (argc <= 1) return list(dac);
  if (std::strcmp(argv[1], "all") == 0) {
    list(dac);
    // Best first, as the app ranks them, so one that dies cannot hide the
    // rest; blocked drivers are left out.
    const std::vector<unsigned int> ids = dac.getDeviceIds();
    std::vector<std::pair<int, size_t>> order;
    for (size_t i = 0; i < ids.size(); i++) {
      const int tier = int(microtone::asio::tierOf(dac.getDeviceInfo(ids[i]).name));
      if (tier >= 0) order.push_back({-tier, i});
    }
    std::stable_sort(order.begin(), order.end());
    int failed = 0;
    for (const auto &[tier, i] : order) {
      std::printf("\ntone through driver %zu:\n", i);
      failed |= play(dac, i, 0, 0);
    }
    return failed;
  }
  if (std::strcmp(argv[1], "panel") == 0) return argc > 2 ? panel(dac, size_t(std::atoi(argv[2]))) : 1;
  if (std::strcmp(argv[1], "-h") == 0 || std::strcmp(argv[1], "--help") == 0) {
    std::printf("asio-probe                   list the ASIO drivers\n"
                "asio-probe all               …and a tone through each the app may use, best first\n"
                "asio-probe <n> [rate] [frames]  a tone through driver n (frames 0: its own size)\n"
                "asio-probe panel <n>          driver n's settings window\n"
                "asio-probe check \"<name>\"     the app's check of that driver alone (silent)\n");
    return 0;
  }
  return play(dac, size_t(std::atoi(argv[1])), argc > 2 ? unsigned(std::atoi(argv[2])) : 0u,
              argc > 3 ? unsigned(std::atoi(argv[3])) : 0u);
}
