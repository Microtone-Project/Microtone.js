#include "nativeaudio.h"

#include <QDateTime>
#include <QFile>
#include <QStringList>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSettings>
#include <QWebSocket>
#include <QtEndian>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

#ifdef __linux__
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusReply>
#include <sched.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "linuxaudiowatch.h"
#endif

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

#ifdef __APPLE__
// Keep AssertMacros.h's short names (check, verify, require) out of the way.
#define __ASSERT_MACROS_DEFINE_VERSIONS_WITHOUT_UNDERSCORES 0
#include <CoreAudio/CoreAudio.h>
#endif

#include "RtAudio.h"
#include "asiotiers.h"
#if MICROTONE_ASIO
#include "asiocheck.h"
#include "asiodriver.h"
#endif

namespace microtone {

namespace {

using Clock = std::chrono::steady_clock;

int64_t steadyMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
}

uint64_t nanosSince(Clock::time_point t0) {
  return (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - t0).count();
}

void storeMax(std::atomic<uint64_t> &slot, uint64_t v) {
  if (v > slot.load(std::memory_order_relaxed)) slot.store(v, std::memory_order_relaxed);
}

// The host → page message kinds (native-engine.js NATIVE_MSG).
enum : uint8_t { kStatus = 0, kSnapshot = 1, kInvertMask = 2, kProfile = 3, kDevices = 4 };

// Engine frames rendered at a time on their way into the resampler.
constexpr int kScratchFrames = 2048;

QByteArray header(uint8_t kind) {
  QByteArray b(4, '\0');
  b[0] = char(kind);
  return b;
}

void appendU32(QByteArray &b, uint32_t v) {
  const uint32_t le = qToLittleEndian(v);
  b.append(reinterpret_cast<const char *>(&le), 4);
}

bool named(const char *name, int len, const char *want) {
  return size_t(len) == std::strlen(want) && std::memcmp(name, want, size_t(len)) == 0;
}

/** The transport commands that jump the play position: the resampler's tail
 *  is dropped after them (engine-commands.js isTransportReset). */
bool jumpsTransport(const char *name, int len) {
  for (const char *n : {"PLAY", "STOP", "SET_CUE_POSITION", "SET_TRACKER_ROW", "CHASE_TRACKER_ROW", "RESET_PARAMS"}) {
    if (named(name, len, n)) return true;
  }
  return false;
}

RtAudio::Api apiNamed(const QString &name) {
  if (name.isEmpty()) return RtAudio::UNSPECIFIED;
  std::vector<RtAudio::Api> apis;
  RtAudio::getCompiledApi(apis);
  for (RtAudio::Api api : apis) {
    if (name.compare(QString::fromStdString(RtAudio::getApiName(api)), Qt::CaseInsensitive) == 0) return api;
  }
  return RtAudio::UNSPECIFIED;
}

/** Linux: PulseAudio first (PipeWire answers it, and it follows the desktop's
 *  own choice of output), then ALSA, then JACK; elsewhere RtAudio's order. */
std::vector<RtAudio::Api> apiOrder() {
  std::vector<RtAudio::Api> compiled;
  RtAudio::getCompiledApi(compiled);
  std::vector<RtAudio::Api> order;
  for (RtAudio::Api preferred : {RtAudio::LINUX_PULSE, RtAudio::LINUX_ALSA, RtAudio::UNIX_JACK}) {
    if (std::find(compiled.begin(), compiled.end(), preferred) != compiled.end()) order.push_back(preferred);
  }
  for (RtAudio::Api api : compiled) {
    // RtAudio's stand-in where none of its own is compiled (Windows, where
    // WASAPI is ours) plays nothing.
    if (api == RtAudio::RTAUDIO_DUMMY) continue;
    if (std::find(order.begin(), order.end(), api) == order.end()) order.push_back(api);
  }
  return order;
}

/** RtAudio's warnings, logged — a driver that would not load is one, and the
 *  log is where someone finds out why a device is missing — but one said
 *  again and again (an underrun each time; a broken stream's, every period
 *  until it is closed) as one line and a count. Any thread. */
void logWarning(const std::string &text) {
  static std::mutex m;
  static std::string last;
  static unsigned repeats = 0;
  static int64_t sinceMs = 0;
  std::lock_guard<std::mutex> lock(m);
  const int64_t now = steadyMs();
  if (text == last && now - sinceMs < 5000) {
    repeats++;
    return;
  }
  if (repeats > 0) qInfo("audio: RtAudio: (the warning above, %u more times)", repeats);
  last = text;
  repeats = 0;
  sinceMs = now;
  qInfo("audio: RtAudio: %s", text.c_str());
}

/** RtAudio's Linux backends tell of a stream whose writes fail only as a
 *  warning, and go on trying, at once and for ever: ALSA when its device was
 *  unplugged ("No such device"), PulseAudio when the server went, JACK when
 *  the server's buffer size changed. The stream is lost then. An ALSA
 *  underrun is a dropout, not a loss. (RtAudio 6.0.1's words: vendored,
 *  pinned.) */
bool linuxStreamBroken(const std::string &text) {
  for (const char *where : {"RtApiAlsa::callbackEvent", "RtApiPulse::callbackEvent", "RtApiJack::callbackEvent"}) {
    if (text.rfind(where, 0) == 0) return text.find("audio write error, underrun") == std::string::npos;
  }
  return false;
}

/** An RtAudio for `api`. Its errors are logged; the open stream's "device
 *  disconnected" — which ASIO also says when its driver asks to be reset —
 *  reaches `owner`, and so does a Linux stream that broke. */
std::unique_ptr<RtAudio> makeDac(RtAudio::Api api, NativeAudio *owner = nullptr) {
  return std::make_unique<RtAudio>(api, [owner](RtAudioErrorType type, const std::string &text) {
    if (type == RTAUDIO_WARNING) logWarning(text);
    else qWarning("audio: RtAudio error %d: %s", int(type), text.c_str());
    if (owner == nullptr) return;
    if (type == RTAUDIO_DEVICE_DISCONNECT) owner->deviceLost();
    else if (type == RTAUDIO_WARNING && linuxStreamBroken(text)) owner->streamBroke();
  });
}

/** Is `c` among the devices of a list devices() made? "The default" is,
 *  while its API has any device. */
bool listed(const QJsonObject &list, const NativeAudio::Config &c) {
  for (const QJsonValue &a : list.value(QStringLiteral("apis")).toArray()) {
    const QJsonObject api = a.toObject();
    if (api.value(QStringLiteral("id")).toString() != c.api) continue;
    const QJsonArray devices = api.value(QStringLiteral("devices")).toArray();
    if (c.device.isEmpty()) return !devices.isEmpty();
    for (const QJsonValue &d : devices) {
      if (d.toObject().value(QStringLiteral("id")).toString() == c.device) return true;
    }
    return false;
  }
  return false;
}

/** A setting in words, for the log and the crash guard. */
QString describe(const NativeAudio::Config &c) {
  QStringList parts{c.api.isEmpty() ? QStringLiteral("the first API") : c.api};
  if (!c.mode.isEmpty()) parts << c.mode;
  parts << (c.device.isEmpty() ? QStringLiteral("default device") : QStringLiteral("device ") + c.device);
  parts << (c.rate != 0 ? QString::number(c.rate) + QStringLiteral(" Hz") : QStringLiteral("rate automatic"));
  parts << (c.bufferFrames != 0                   ? QString::number(c.bufferFrames) + QStringLiteral(" frames")
            : c.api == QLatin1String("jack") ? QStringLiteral("the server's buffer")
                                             : QStringLiteral("the driver's buffer"));
  return parts.join(QStringLiteral(", "));
}

#ifdef __APPLE__
const AudioObjectPropertyAddress kDefaultOutput = {kAudioHardwarePropertyDefaultOutputDevice,
                                                   kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};

const AudioObjectPropertyAddress kDeviceList = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                                kAudioObjectPropertyElementMain};

OSStatus onDefaultOutput(AudioObjectID, UInt32, const AudioObjectPropertyAddress *, void *user) {
  static_cast<NativeAudio *>(user)->defaultOutputChanged();
  static_cast<NativeAudio *>(user)->devicesChanged();  // the "default" mark moved
  return noErr;
}

OSStatus onDeviceList(AudioObjectID, UInt32, const AudioObjectPropertyAddress *, void *user) {
  static_cast<NativeAudio *>(user)->devicesChanged();
  return noErr;
}
#endif

#if MICROTONE_ASIO
/** A device's own sample format as RtAudio probes it (one bit set), in the
 *  words wasapi.c uses. */
QString formatName(RtAudioFormat f) {
  if (f & RTAUDIO_FLOAT32) return QStringLiteral("32-bit float");
  if (f & RTAUDIO_FLOAT64) return QStringLiteral("64-bit float");
  if (f & RTAUDIO_SINT32) return QStringLiteral("32-bit PCM");
  if (f & RTAUDIO_SINT24) return QStringLiteral("24-bit PCM");
  if (f & RTAUDIO_SINT16) return QStringLiteral("16-bit PCM");
  return {};
}
#endif

/** ASIO has no system default: the first driver of the best tier
 *  (asiotiers.h), never a blocked one. 0 when there is none. */
unsigned int preferredAsioDriver(RtAudio *dac) {
  unsigned int best = 0;
  int bestTier = -1;
  for (unsigned int id : dac->getDeviceIds()) {
    const RtAudio::DeviceInfo info = dac->getDeviceInfo(id);
    if (info.outputChannels < 2) continue;
    const int tier = int(asio::tierOf(info.name));
    if (tier > bestTier) {  // a blocked driver (-1) never beats "none"
      best = id;
      bestTier = tier;
    }
  }
  return best;
}

}  // namespace

NativeAudio::NativeAudio(QObject *parent) : QObject(parent) {
#if MICROTONE_ASIO
  // First: the drivers not yet tried are tried now, in the background, and
  // RtAudio loads none that crashed or hung there (nor any not yet tried).
  asioCheck_ = std::make_unique<asio::AsioCheck>([this] {
    asioStale_ = true;
    devicesChanged();  // the list now has the drivers that passed
  });
  asioCheck_->start();
#endif
  mt_snap_layout(&layout_);
  for (Slot &s : slots_) s.f.assign(size_t(layout_.floats), 0.0f);
  scratch_.assign(size_t(kScratchFrames) * 2, 0.0f);
  host_ = mt_host_new(int(kEngineRate));
#ifdef _WIN32
  guiThread_ = GetCurrentThreadId();
#endif
#if MICROTONE_WASAPI
  watch_ = mt_wasapi_watch(&NativeAudio::wasapiNotify, this);
#endif
#ifdef __APPLE__
  AudioObjectAddPropertyListener(kAudioObjectSystemObject, &kDefaultOutput, &onDefaultOutput, this);
  AudioObjectAddPropertyListener(kAudioObjectSystemObject, &kDeviceList, &onDeviceList, this);
#endif
#ifdef __linux__
  linuxWatch_ = std::make_unique<LinuxAudioWatch>(LinuxAudioWatch::Hooks{
      [this] { devicesChanged(); },
      [this] { defaultOutputChanged(); },
      [this] { deviceLost(); },
  });
#endif
  pump_.setInterval(4);
  connect(&pump_, &QTimer::timeout, this, &NativeAudio::pump);
}

NativeAudio::~NativeAudio() {
#if MICROTONE_ASIO
  asioCheck_.reset();  // a check under way is ended; no callback after this
#endif
#ifdef __linux__
  linuxWatch_.reset();  // no hook runs after this
#endif
#if MICROTONE_WASAPI
  mt_wasapi_unwatch(watch_);  // no callback runs after this
  watch_ = nullptr;
#endif
#ifdef __APPLE__
  AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &kDefaultOutput, &onDefaultOutput, this);
  AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &kDeviceList, &onDeviceList, this);
#endif
  pump_.stop();
  closeDevice();
  closerDone(2000);
  // A normal quit, however soon after an open, is not a death.
  clearOpening();
  std::lock_guard<std::mutex> lock(engine_);
  mt_host_free(host_);
  host_ = nullptr;
}

// ── the output ──

NativeAudio::Config NativeAudio::remembered() {
  QSettings s;
  Config c;
  c.api = s.value(QStringLiteral("audio/api")).toString();
  c.device = s.value(QStringLiteral("audio/device")).toString();
  c.rate = s.value(QStringLiteral("audio/rate"), 0u).toUInt();
  c.bufferFrames = s.value(QStringLiteral("audio/bufferFrames"), 256u).toUInt();
  c.mode = s.value(QStringLiteral("audio/mode")).toString();
  return c;
}

void NativeAudio::remember(const Config &c) {
  QSettings s;
  s.setValue(QStringLiteral("audio/api"), c.api);
  s.setValue(QStringLiteral("audio/device"), c.device);
  s.setValue(QStringLiteral("audio/rate"), c.rate);
  s.setValue(QStringLiteral("audio/bufferFrames"), c.bufferFrames);
  s.setValue(QStringLiteral("audio/mode"), c.mode);
}

bool NativeAudio::start(QString *error) {
  if (host_ == nullptr) {
    if (error) *error = QStringLiteral("out of memory");
    return false;
  }
  Config wanted = remembered();
  if (qEnvironmentVariableIsSet("MICROTONE_AUDIO_API")) {
    wanted.api = qEnvironmentVariable("MICROTONE_AUDIO_API").toLower();
    wanted.device.clear();
  }
  if (qEnvironmentVariableIntValue("MICROTONE_BUFFER_FRAMES") > 0)
    wanted.bufferFrames = unsigned(qEnvironmentVariableIntValue("MICROTONE_BUFFER_FRAMES"));
  const unsigned envRate = unsigned(std::max(0, qEnvironmentVariableIntValue("MICROTONE_SAMPLE_RATE")));
  if (envRate > 0) wanted.rate = envRate;

  dumpPath_ = qEnvironmentVariable("MICROTONE_NATIVE_DUMP");
  if (!dumpPath_.isEmpty()) {
    const int seconds = qEnvironmentVariableIntValue("MICROTONE_NATIVE_DUMP_SECONDS");
    dump_.assign(size_t(192000) * size_t(seconds > 0 ? seconds : 30) * 2, 0.0f);  // any device rate
  }

  // The crash guard: an output is marked as being opened (markOpening) until
  // it has played for a few seconds. A mark found now means the last run died
  // in that window: its setting is skipped for the defaults, and the page is
  // told. Twice running, the defaults too: Web Audio this time, native audio
  // again on the next start.
  {
    QSettings s;
    const QString died = s.value(QStringLiteral("audio/opening")).toString();
    if (!died.isEmpty()) {
      const int deaths = s.value(QStringLiteral("audio/deaths"), 0).toInt() + 1;
      s.remove(QStringLiteral("audio/opening"));
      s.setValue(QStringLiteral("audio/deaths"), deaths >= 2 ? 0 : deaths);
      s.sync();
      recovered_ = died;
      qWarning("audio: the last run stopped while opening %s (%d in a row)", qUtf8Printable(died), deaths);
      if (deaths >= 2) {
        if (error) *error = QStringLiteral("the last two runs stopped while opening an output");
        return false;
      }
      wanted.api.clear();  // the defaults, below
    } else {
      s.setValue(QStringLiteral("audio/deaths"), 0);
    }
  }
  qInfo("audio: starting; the remembered setting: %s",
        wanted.api.isEmpty() ? "none" : qUtf8Printable(describe(wanted)));

  QString why;
  // Nothing remembered (a first start) goes straight to the defaults: an
  // empty setting would open RtAudio's first API, ahead of WASAPI. What was
  // remembered and is gone (unplugged, another machine) goes there too, and
  // is opened when it is listed again.
  chosen_ = wanted;
  bool ok = !wanted.api.isEmpty() && open(wanted, &why);
  if (!ok && openDefaults(wanted.bufferFrames, envRate, &why)) {
    ok = true;
    onFallback_ = !chosen_.api.isEmpty();
  }
  if (ok) {
    if (chosen_.api.isEmpty()) chosen_ = config_;  // nothing chosen yet: what the defaults gave
    pump_.start();
    return true;
  }
  if (error) *error = why.isEmpty() ? QStringLiteral("no audio API was compiled in") : why;
  return false;
}

/** The defaults: on Windows WASAPI — at a short period where the driver
 *  allows one, else through the mixer as every program plays — then
 *  RtAudio's APIs in order (Linux: PulseAudio, ALSA, JACK; Windows: ASIO, at
 *  the driver's own size; macOS: Core Audio). `rate` 0 is the usual choice;
 *  only MICROTONE_SAMPLE_RATE asks for another. */
bool NativeAudio::openDefaults(unsigned bufferFrames, unsigned rate, QString *error) {
#if MICROTONE_WASAPI
  for (const char *mode : {"lowLatency", "shared"}) {
    Config c;
    c.api = QStringLiteral("wasapi");
    c.mode = QString::fromLatin1(mode);
    c.bufferFrames = bufferFrames;
    if (open(c, error)) return true;
  }
#endif
  for (RtAudio::Api api : apiOrder()) {
    Config c;
    c.api = QString::fromStdString(RtAudio::getApiName(api));
    c.bufferFrames = api == RtAudio::WINDOWS_ASIO ? 0 : bufferFrames;
    c.rate = rate;
    if (open(c, error)) return true;
  }
  return false;
}

void NativeAudio::closeDevice() {
  if (running_) qInfo("audio: closing %s", qUtf8Printable(apiName_));
  live_ = false;
#if MICROTONE_WASAPI
  if (wasapi_ != nullptr) {
    mt_wasapi_close(wasapi_);
    wasapi_ = nullptr;
  }
#endif
#ifdef __linux__
  // Before the stream's own client goes: that is no news.
  if (linuxWatch_) linuxWatch_->unwatchJack();
#endif
  if (dac_) {
#ifdef __linux__
    // A lost stream is aborted, not drained: RtAudio's JACK stop waits for
    // a process callback that a client JACK has stopped (a new buffer size)
    // never makes, and a gone device has nothing to drain.
    if (dac_->isStreamRunning()) {
      if (lost_) dac_->abortStream();
      else dac_->stopStream();
    }
#else
    if (dac_->isStreamRunning()) dac_->stopStream();
#endif
    if (dac_->isStreamOpen()) dac_->closeStream();
  }
  running_ = false;
  standIn_ = false;
  followsDefault_ = false;
#ifdef __linux__
  paceWhenLost_ = false;
#endif
  format_.clear();
  latencyMs_ = 0.0;
  driverPanel_ = false;
  bufMin_ = bufMax_ = bufStep_ = bufPreferred_ = 0;
}

/** Open `want` (closing what is open first). On success the host's state
 *  follows the new stream; on failure nothing is open. Either way a loss
 *  reported before is answered. */
bool NativeAudio::open(const Config &want, QString *error) {
  qInfo("audio: opening %s", qUtf8Printable(describe(want)));
  markOpening(want);
  QString why;
  const bool ok = openOne(want, &why);
  if (ok) {
    qInfo("audio: open: %s \"%s\" at %u Hz, %u frames%s%s; latency %.1f ms", qUtf8Printable(apiName_),
          qUtf8Printable(device_), rate_, bufferFrames_, format_.isEmpty() ? "" : ", ",
          qUtf8Printable(format_), status().value(QStringLiteral("latencyMs")).toDouble());
    // Cleared once it has played a while: a death before that is its.
    const unsigned generation = openGeneration_;
    QTimer::singleShot(5000, this, [this, generation] {
      if (generation == openGeneration_ && running_) clearOpening();
    });
  } else {
    qWarning("audio: would not open (%s): %s", qUtf8Printable(describe(want)), qUtf8Printable(why));
    clearOpening();
  }
  if (error) *error = why;
  return ok;
}

void NativeAudio::markOpening(const Config &config) {
  ++openGeneration_;
  QSettings s;
  s.setValue(QStringLiteral("audio/opening"), describe(config));
  s.sync();  // on disk now: this is for the case where nothing after runs
}

void NativeAudio::clearOpening() {
  QSettings s;
  s.remove(QStringLiteral("audio/opening"));
  s.sync();
}

bool NativeAudio::openOne(const Config &want, QString *error) {
  closeDevice();
  // An ASIO driver RtAudio is still unloading must be gone before one loads.
  closerDone(2000);
  lost_ = false;
#if MICROTONE_WASAPI
  if (want.api == QLatin1String("wasapi")) {
    Config c = want;
    if (c.bufferFrames == 0) c.bufferFrames = 256;
    return openWasapi(c, error);
  }
#endif
  return openRtAudio(want, error);
}

/** Windows: true once the RtAudio thread closing a lost ASIO stream (its
 *  driver asked for a reset) has ended, waiting up to `ms` for it. */
bool NativeAudio::closerDone(unsigned ms) {
#ifdef _WIN32
  void *h = closer_.exchange(nullptr);
  if (h == nullptr) return true;
  if (WaitForSingleObject(h, ms) == WAIT_TIMEOUT) {
    if (void *other = closer_.exchange(h)) CloseHandle(other);
    return false;
  }
  CloseHandle(h);
#else
  Q_UNUSED(ms);
#endif
  return true;
}

void NativeAudio::deviceLost() {
#ifdef _WIN32
  // ASIO says so from a thread of RtAudio's that goes on to dispose of the
  // buffers and unload the driver: whoever opens next waits for it to end.
  if (GetCurrentThreadId() != guiThread_) {
    HANDLE h = nullptr;
    if (DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &h, SYNCHRONIZE, FALSE, 0)) {
      if (void *old = closer_.exchange(h)) CloseHandle(old);
    }
  }
#endif
  markLost();
}

void NativeAudio::streamBroke() {
  // Not markLost() each time: the reopen waits for a quiet quarter second
  // after the last word, and this word comes every period.
  if (!lost_.load()) markLost();
}

void NativeAudio::markLost() {
  lostAtMs_ = steadyMs();
  lost_ = true;
}

void NativeAudio::defaultOutputChanged() {
  // Not deviceLost(): this comes on a long-lived thread of the system's,
  // which the reopen must not wait for as for RtAudio's closing one.
  if (!followsDefault_) return;
  qInfo("audio: the system's default output changed; following it");
  markLost();
}

void NativeAudio::devicesChanged() {
  devicesAtMs_ = steadyMs();
  devicesDirty_ = true;
}

/** On the pump: the device went away, or its driver asked to be reset (an
 *  ASIO panel's new buffer or rate takes effect so). The same setting again;
 *  if that will not open, the defaults, and the page is told why. */
void NativeAudio::reopenLost() {
  if (!closerDone(0)) return;  // RtAudio is still closing it: the next tick
  // A quarter of a second to settle: Core Audio's "device gone" closes the
  // stream on a notification thread of its own, and plugging something in
  // can change the default more than once.
  if (steadyMs() - lostAtMs_.load() < 250) return;
  const qint64 now = QDateTime::currentMSecsSinceEpoch();
  if (now - lastReopenMs_ < 1000) return;  // a device that keeps going: once a second at most
  lastReopenMs_ = now;
  qInfo("audio: the output went away; opening it again");
  const Config again = config_;
  QString why;
  if (open(again, &why)) {
    lastError_.clear();
  } else {
    lastError_ = why.isEmpty() ? QStringLiteral("the device went away") : why;
    QString more;
    openDefaults(again.bufferFrames, 0, &more);
    onFallback_ = !chosen_.api.isEmpty();  // the chosen one, when it is back
  }
  sendStatus();
  devicesChanged();  // whatever went away is gone from the list too
}

/** After a device change, on Linux: is the open device gone from the list?
 *  A PulseAudio stream whose sink went is moved to another by the server,
 *  and an ALSA or JACK one plays into nothing: either way it is opened
 *  again, so the tab says where it plays. (macOS and Windows say so
 *  themselves: RtAudio's "disconnected", wasapi.c's lost stream.) */
bool NativeAudio::openDeviceGone(const QJsonObject &list) const {
#ifdef __linux__
  if (!running_ || !dac_ || !dac_->isStreamOpen()) return false;
  for (const QJsonValue &a : list.value(QStringLiteral("apis")).toArray()) {
    const QJsonObject api = a.toObject();
    if (api.value(QStringLiteral("id")).toString() != config_.api) continue;
    for (const QJsonValue &d : api.value(QStringLiteral("devices")).toArray()) {
      if (d.toObject().value(QStringLiteral("name")).toString() == device_) return false;
    }
    return true;
  }
#else
  Q_UNUSED(list);
#endif
  return false;
}

/** After a device change: when a loss put another output (or none) in place
 *  of the one the person chose, or the default stands in for the device it
 *  names, and that one is listed again — plugged back in, its server
 *  started — it is opened; if it will not open, what played before plays
 *  on. With nothing open at all, the defaults at least. True when it
 *  tried. */
bool NativeAudio::returnToChosen(const QJsonObject &list) {
  if (!(onFallback_ || standIn_) || chosen_.api.isEmpty()) return false;
  const bool back = listed(list, chosen_);
  if (!back && running_) return false;
  // Once a second at most (a chosen output that dies as it opens must not
  // be opened round and round); one that has to wait is not dropped.
  const qint64 now = QDateTime::currentMSecsSinceEpoch();
  if (now - lastReturnMs_ < 1000) {
    devicesChanged();
    return false;
  }
  lastReturnMs_ = now;
  const Config fallback = config_;
  const bool wasRunning = running_;
  QString why;
  if (back) {
    qInfo("audio: the chosen output is listed again; opening it");
    if (open(chosen_, &why)) {
      onFallback_ = false;
      lastError_.clear();
      sendStatus();
      return true;
    }
  }
  if (!wasRunning || !open(fallback, &why)) openDefaults(chosen_.bufferFrames, 0, &why);
  sendStatus();
  return true;
}

/** Linux: while the person's choice is JACK and JACK is not open, look for
 *  its server (the list says nothing when one starts). */
void NativeAudio::updateLooks() {
#ifdef __linux__
  if (linuxWatch_) {
    const QString jack = QStringLiteral("jack");
    linuxWatch_->lookForJack(onFallback_ && chosen_.api == jack && !(running_ && config_.api == jack));
  }
#endif
}

/** HOST_PANEL: the open ASIO driver's own settings window. A change made
 *  there (the buffer, the clock) comes back as the driver's reset request,
 *  which reopens the stream: with the driver's size chosen, at the new size. */
void NativeAudio::openDriverPanel() {
#if MICROTONE_ASIO
  qInfo("audio: the driver's settings window");
  if (driverPanel_ && dac_ && dac_->isStreamOpen() && !lost_) asio::controlPanel();
#endif
}

bool NativeAudio::openRtAudio(const Config &want, QString *error) {
  RtAudio::Api api = apiNamed(want.api);
  if (api == RtAudio::UNSPECIFIED) api = apiOrder().empty() ? RtAudio::UNSPECIFIED : apiOrder().front();
#if MICROTONE_ASIO
  // Loading ASIO waits for the drivers to be tried: one not yet tried is not
  // loaded (a minute at most; then the untried stay out).
  if (api == RtAudio::WINDOWS_ASIO && asioCheck_ && asioCheck_->checking()) {
    qInfo("audio: waiting for the ASIO drivers to be tried");
    if (!asioCheck_->wait(60000)) qWarning("audio: the ASIO checks are still running; untried drivers stay out");
  }
#endif
  // PulseAudio afresh each time: RtAudio marks the default sink once, when
  // it first lists it, and opens "the default" by that sink's name.
  if (!dac_ || dac_->getCurrentApi() != api || api == RtAudio::LINUX_PULSE) {
    dac_.reset();
    dac_ = makeDac(api, this);
  }
  const QString apiName = QString::fromStdString(RtAudio::getApiDisplayName(api));

  // The device by name (ids are not stable across runs); none, or one that
  // has gone, is the system's default output — for ASIO, which has no such
  // thing, the best driver by asiotiers.h. A driver known to crash the app is
  // never opened, even when a setting names it.
  const bool asioApi = api == RtAudio::WINDOWS_ASIO;
  unsigned int id = 0;
  RtAudio::DeviceInfo info;
  for (unsigned int candidate : dac_->getDeviceIds()) {
    const RtAudio::DeviceInfo i = dac_->getDeviceInfo(candidate);
    if (i.outputChannels >= 2 && !want.device.isEmpty() && QString::fromStdString(i.name) == want.device) {
      if (asioApi && asio::tierOf(i.name) == asio::Tier::Blocked) {
        qWarning("audio: the ASIO driver \"%s\" is known to crash the app: not opening it", i.name.c_str());
        break;
      }
      id = candidate;
      info = i;
      break;
    }
  }
  // A device named and not found (unplugged, another machine): the default
  // stands in, and the named one is opened when it is listed again.
  const bool standIn = id == 0 && !want.device.isEmpty();
  if (id == 0) {
    id = asioApi ? preferredAsioDriver(dac_.get()) : dac_->getDefaultOutputDevice();
    if (id != 0) info = dac_->getDeviceInfo(id);
    if (id != 0 && asioApi) {
      qInfo("audio: ASIO's default is \"%s\" (%s)", info.name.c_str(), asio::tierName(asio::tierOf(info.name)));
    }
  }
  if (id == 0) {
    if (error) *error = QStringLiteral("no output device for %1").arg(apiName);
    return false;
  }

  unsigned int rate = want.rate;
  const auto has = [&](unsigned int r) {
    return info.sampleRates.empty() || std::find(info.sampleRates.begin(), info.sampleRates.end(), r) != info.sampleRates.end();
  };
  // Core Audio sets the device's own rate — for every app — when asked for
  // another, so there "automatic" keeps the rate the system has it at, and
  // the engine is converted to it. Elsewhere: 48 kHz where the device has it.
  const bool keepsRate = api == RtAudio::MACOSX_CORE && info.currentSampleRate != 0;
  if (rate == 0 || !has(rate)) {
    rate = keepsRate          ? info.currentSampleRate
           : has(kEngineRate) ? kEngineRate
           : info.preferredSampleRate ? info.preferredSampleRate
                                      : info.sampleRates.back();
  }

  RtAudio::StreamParameters out;
  out.deviceId = id;
  out.nChannels = 2;
  RtAudio::StreamOptions options;
  options.flags = RTAUDIO_SCHEDULE_REALTIME;
  options.streamName = "Microtone";
  // 0: the driver's own size where it has one (ASIO's "preferred", what its
  // panel is set to), 256 elsewhere. RtAudio fits a size to the driver's.
  // JACK's is the server's, for every client: nothing is asked.
  const bool isAsio = api == RtAudio::WINDOWS_ASIO;
  const bool isJack = api == RtAudio::UNIX_JACK;
  const unsigned int asked = isJack ? 0 : want.bufferFrames != 0 || isAsio ? want.bufferFrames : 256;
  unsigned int frames = asked;
  if (dac_->openStream(&out, nullptr, RTAUDIO_FLOAT32, rate, &frames, &NativeAudio::callback, this, &options) !=
      RTAUDIO_NO_ERROR) {
    if (error) *error = QString::fromStdString(dac_->getErrorText());
    return false;
  }

  rate_ = dac_->getStreamSampleRate();
  bufferFrames_ = frames;
  streamLatency_ = dac_->getStreamLatency();
  apiName_ = apiName;
  device_ = QString::fromStdString(info.name);
  config_ = Config{QString::fromStdString(RtAudio::getApiName(api)), want.device, want.rate, asked, {}};
#if MICROTONE_ASIO
  if (isAsio) {
    // The driver's limits, for the tab's buffer sizes; its sample format
    // (RtAudio converts to it); the latency it reports, which already holds
    // the buffer.
    driverPanel_ = true;
    asio::BufferLimits l;
    if (asio::bufferLimits(&l)) {
      bufPreferred_ = l.preferred;
      bufMin_ = l.granularity == 0 ? l.preferred : l.min;
      bufMax_ = l.granularity == 0 ? l.preferred : l.max;
      bufStep_ = l.granularity > 0 ? l.granularity : 1;
    }
    format_ = formatName(info.nativeFormats);
    if (rate_ > 0) latencyMs_ = std::max(streamLatency_, bufferFrames_) * 1000.0 / rate_;
  }
#endif
  {
    std::lock_guard<std::mutex> lock(engine_);
    resampler_.configure(kEngineRate, rate_);
    framesSinceSnap_ = 0;
  }
  if (!dumpWritten_) {
    const int seconds = qEnvironmentVariableIntValue("MICROTONE_NATIVE_DUMP_SECONDS");
    dumpUsed_ = 0;
    dumpTarget_ = std::min(dump_.size(), size_t(rate_) * size_t(seconds > 0 ? seconds : 30) * 2);
  }
  callbackTid_ = 0;
  realtimeAsked_ = false;
  realtime_.clear();
#ifndef __linux__
  // The callback runs on the API's own thread, at the priority it gives it:
  // nothing to ask for (Linux asks RealtimeKit, in pump).
  realtimeAsked_ = true;
  if (isAsio) realtime_ = QStringLiteral("ASIO driver thread");
  else if (api == RtAudio::MACOSX_CORE) realtime_ = QStringLiteral("Core Audio I/O thread");
#endif

  live_ = true;
  if (dac_->startStream() != RTAUDIO_NO_ERROR) {
    live_ = false;
    if (error) *error = QString::fromStdString(dac_->getErrorText());
    dac_->closeStream();
    return false;
  }
  running_ = true;
  standIn_ = standIn;
  followsDefault_ = (api == RtAudio::MACOSX_CORE || api == RtAudio::LINUX_PULSE) && want.device.isEmpty();
#ifdef __linux__
  paceWhenLost_ = api == RtAudio::LINUX_ALSA || api == RtAudio::LINUX_PULSE;
  if (isJack && linuxWatch_) linuxWatch_->watchJack(info.name, rate_, bufferFrames_);
#endif
  return true;
}

#if MICROTONE_WASAPI
void NativeAudio::wasapiRender(void *user, float *out, int frames) {
  static_cast<NativeAudio *>(user)->process(out, unsigned(frames), 0);
}

/** On a thread of the system's (IMMNotificationClient): note it, nothing
 *  more — the pump does the rest. */
void NativeAudio::wasapiNotify(void *user, MtWasapiChange change) {
  auto *self = static_cast<NativeAudio *>(user);
  if (change == MT_WASAPI_DEFAULT) self->defaultOutputChanged();
  self->devicesChanged();
}

/** WASAPI (wasapi.c): the mode, the device by endpoint id, our rate in
 *  exclusive mode, and the buffer as the period asked for. */
bool NativeAudio::openWasapi(const Config &want, QString *error) {
  const MtWasapiMode mode = want.mode == QLatin1String("exclusive") ? MT_WASAPI_EXCLUSIVE
                            : want.mode == QLatin1String("shared")  ? MT_WASAPI_SHARED
                                                                    : MT_WASAPI_SHARED_LOW_LATENCY;
  MtWasapiInfo info{};
  char why[256] = "";
  MtWasapiStream *s = mt_wasapi_open(want.device.toUtf8().constData(), mode,
                                     mode == MT_WASAPI_EXCLUSIVE ? int(want.rate) : 0, int(want.bufferFrames),
                                     &NativeAudio::wasapiRender, this, &info, why, int(sizeof why));
  if (s == nullptr) {
    if (error) *error = QString::fromUtf8(why);
    return false;
  }
  wasapi_ = s;
  wasapiGlitches_ = 0;
  rate_ = unsigned(info.rate);
  bufferFrames_ = unsigned(info.periodFrames);
  streamLatency_ = 0;
  latencyMs_ = info.latencyMs;
  format_ = QString::fromUtf8(info.format);
  apiName_ = QStringLiteral("WASAPI");
  device_ = QString::fromUtf8(info.name);
  config_ = Config{QStringLiteral("wasapi"), want.device, mode == MT_WASAPI_EXCLUSIVE ? want.rate : 0,
                   want.bufferFrames,
                   mode == MT_WASAPI_EXCLUSIVE ? QStringLiteral("exclusive")
                   : mode == MT_WASAPI_SHARED  ? QStringLiteral("shared")
                                               : QStringLiteral("lowLatency")};
  {
    std::lock_guard<std::mutex> lock(engine_);
    resampler_.configure(kEngineRate, rate_);
    framesSinceSnap_ = 0;
  }
  if (!dumpWritten_) {
    const int seconds = qEnvironmentVariableIntValue("MICROTONE_NATIVE_DUMP_SECONDS");
    dumpUsed_ = 0;
    dumpTarget_ = std::min(dump_.size(), size_t(rate_) * size_t(seconds > 0 ? seconds : 30) * 2);
  }
  // The thread registered itself with MMCSS ("Pro Audio"): Windows' own
  // real-time class for audio, which RealtimeKit stands in for on Linux.
  callbackTid_ = 0;
  realtimeAsked_ = true;
  realtime_ = info.mmcss ? QStringLiteral("MMCSS Pro Audio") : QString();
  live_ = true;
  running_ = true;
  followsDefault_ = want.device.isEmpty();  // the console default, as macOS's
  return true;
}
#endif

/** HOST_CONFIGURE: the page's Settings tab asks for another output. It is
 *  opened at once; if it will not open, the one before comes back. */
void NativeAudio::configure(const QByteArray &json) {
  const QJsonObject o = QJsonDocument::fromJson(json).object();
  Config want;
  want.api = o.value(QStringLiteral("api")).toString();
  want.device = o.value(QStringLiteral("device")).toString();
  want.rate = unsigned(std::max(0, o.value(QStringLiteral("rate")).toInt()));
  const int frames = o.value(QStringLiteral("bufferFrames")).toInt(256);
  want.bufferFrames = frames == 0 ? 0u : unsigned(std::clamp(frames, 16, 8192));  // 0: the driver's
  want.mode = o.value(QStringLiteral("mode")).toString();
  qInfo("audio: the Settings tab asks for %s", qUtf8Printable(describe(want)));
  const Config before = config_;
  QString why;
  if (open(want, &why)) {
    lastError_.clear();
    recovered_.clear();
    remember(config_);
    chosen_ = config_;
    onFallback_ = false;
  } else {
    lastError_ = why.isEmpty() ? QStringLiteral("the device would not open") : why;
    QString again;
    // Not even the old one: the defaults, rather than no sound at all.
    if (!open(before, &again)) {
      openDefaults(before.bufferFrames, 0, &again);
      onFallback_ = !chosen_.api.isEmpty();
    }
  }
  sendStatus();
}

QJsonObject NativeAudio::status() const {
  const double ms = rate_ ? 1000.0 / rate_ : 0.0;
  QJsonObject o{
      {QStringLiteral("ok"), running_},
      {QStringLiteral("api"), apiName_},
      {QStringLiteral("apiId"), config_.api},
      {QStringLiteral("device"), device_},
      {QStringLiteral("deviceChoice"), config_.device},
      {QStringLiteral("rate"), int(rate_)},
      {QStringLiteral("rateChoice"), int(config_.rate)},
      {QStringLiteral("engineRate"), int(kEngineRate)},
      {QStringLiteral("bufferFrames"), int(bufferFrames_)},
      {QStringLiteral("bufferChoice"), int(config_.bufferFrames)},
      {QStringLiteral("bufferMs"), bufferFrames_ * ms},
      {QStringLiteral("latencyMs"), latencyMs_ > 0 ? latencyMs_ : (bufferFrames_ + streamLatency_) * ms},
      {QStringLiteral("mode"), config_.mode},
      {QStringLiteral("format"), format_},
      {QStringLiteral("realtime"), realtime_},
      {QStringLiteral("error"), lastError_},
      {QStringLiteral("recovered"), recovered_},
  };
  // ASIO: the driver has a settings window, and these buffer sizes.
  if (driverPanel_) o.insert(QStringLiteral("driverPanel"), true);
  if (bufMax_ > 0) {
    o.insert(QStringLiteral("bufferLimits"),
             QJsonObject{{QStringLiteral("min"), int(bufMin_)}, {QStringLiteral("max"), int(bufMax_)},
                         {QStringLiteral("step"), int(bufStep_)}, {QStringLiteral("preferred"), int(bufPreferred_)}});
  }
  return o;
}

QJsonObject NativeAudio::devices(bool full) {
  QJsonArray apis;
#if MICROTONE_WASAPI
  {
    // WASAPI first: its devices by endpoint id, and what each mode offers on
    // each (0 frames = not offered), so the tab shows only what will open.
    MtWasapiDevice *list = nullptr;
    const int n = mt_wasapi_list(&list);
    QJsonArray devs;
    const auto rates = [](const int *r, int count) {
      QJsonArray a;
      for (int i = 0; i < count; i++) a.append(r[i]);
      return a;
    };
    for (int i = 0; i < n; i++) {
      const MtWasapiDevice &d = list[i];
      const QJsonArray mix{d.mixRate};
      QJsonObject modes{{QStringLiteral("shared"),
                         QJsonObject{{QStringLiteral("rates"), mix}, {QStringLiteral("min"), d.sharedPeriod}}}};
      modes.insert(QStringLiteral("lowLatency"),
                   d.llStep > 0 ? QJsonValue(QJsonObject{{QStringLiteral("rates"), mix},
                                                         {QStringLiteral("min"), d.llMin},
                                                         {QStringLiteral("max"), d.llMax},
                                                         {QStringLiteral("step"), d.llStep}})
                                : QJsonValue());
      modes.insert(QStringLiteral("exclusive"),
                   d.exRateCount > 0 ? QJsonValue(QJsonObject{{QStringLiteral("rates"), rates(d.exRates, d.exRateCount)},
                                                              {QStringLiteral("min"), d.exMin}})
                                     : QJsonValue());
      devs.append(QJsonObject{
          {QStringLiteral("id"), QString::fromUtf8(d.id)},
          {QStringLiteral("name"), QString::fromUtf8(d.name)},
          {QStringLiteral("isDefault"), d.isDefault != 0},
          {QStringLiteral("rates"), mix},
          {QStringLiteral("preferredRate"), d.mixRate},
          {QStringLiteral("modes"), modes},
      });
    }
    mt_wasapi_free_list(list);
    apis.append(QJsonObject{
        {QStringLiteral("id"), QStringLiteral("wasapi")},
        {QStringLiteral("name"), QStringLiteral("WASAPI")},
        {QStringLiteral("modes"), QJsonArray{QStringLiteral("shared"), QStringLiteral("lowLatency"), QStringLiteral("exclusive")}},
        {QStringLiteral("devices"), devs},
    });
  }
#endif
  for (RtAudio::Api api : apiOrder()) {
    // A list pushed after a device event keeps the last ASIO list (see the
    // header): no driver is loaded for a headset coming in.
    bool asioStale = false;
#if MICROTONE_ASIO
    asioStale = api == RtAudio::WINDOWS_ASIO && asioStale_.exchange(false);
#endif
    if (!full && api == RtAudio::WINDOWS_ASIO && !asioEntry_.isEmpty() && !asioStale) {
      apis.append(asioEntry_);
      continue;
    }
    // The open API answers through its own instance: probing a device it
    // holds from a second one can fail. Not PulseAudio, whose instance
    // keeps the default it first saw (openRtAudio), and whose list is the
    // server's.
    std::unique_ptr<RtAudio> temp;
    RtAudio *dac = dac_ && dac_->getCurrentApi() == api && api != RtAudio::LINUX_PULSE ? dac_.get()
                                                                                      : (temp = makeDac(api)).get();
    // ASIO: the default is the best driver (asiotiers.h), and one known to
    // crash the app is not offered at all.
    const bool asioApi = api == RtAudio::WINDOWS_ASIO;
    const unsigned int asioDefault = asioApi ? preferredAsioDriver(dac) : 0;
    QJsonArray list;
    for (unsigned int id : dac->getDeviceIds()) {
      RtAudio::DeviceInfo info = dac->getDeviceInfo(id);
      if (info.outputChannels < 2) continue;
      if (asioApi) {
        if (asio::tierOf(info.name) == asio::Tier::Blocked) continue;
        info.isDefaultOutput = id == asioDefault;
      }
      QJsonArray rates;
      for (unsigned int r : info.sampleRates) rates.append(int(r));
      list.append(QJsonObject{
          {QStringLiteral("id"), QString::fromStdString(info.name)},
          {QStringLiteral("name"), QString::fromStdString(info.name)},
          {QStringLiteral("isDefault"), info.isDefaultOutput},
          {QStringLiteral("rates"), rates},
          {QStringLiteral("preferredRate"), int(info.preferredSampleRate)},
          {QStringLiteral("currentRate"), int(info.currentSampleRate)},
      });
    }
    QJsonObject entry{
        {QStringLiteral("id"), QString::fromStdString(RtAudio::getApiName(api))},
        {QStringLiteral("name"), QString::fromStdString(RtAudio::getApiDisplayName(api))},
        {QStringLiteral("devices"), list},
    };
    if (api == RtAudio::WINDOWS_ASIO) {
      // The size is the driver's to set (0 asks for it), in its own window.
      entry.insert(QStringLiteral("driverBuffer"), true);
      entry.insert(QStringLiteral("driverPanel"), true);
#if MICROTONE_ASIO
      // The drivers left out, and why; and whether some are still being
      // tried (the list grows when they pass).
      if (asioCheck_) {
        entry.insert(QStringLiteral("refused"), asioCheck_->refused());
        entry.insert(QStringLiteral("checking"), asioCheck_->checking());
      }
#endif
    }
    // Rate 0 keeps the device's own rate (above); another one changes it.
    if (api == RtAudio::MACOSX_CORE) entry.insert(QStringLiteral("keepsDeviceRate"), true);
    // JACK's server sets the rate and the buffer for every client.
    if (api == RtAudio::UNIX_JACK) {
      entry.insert(QStringLiteral("serverRate"), true);
      entry.insert(QStringLiteral("serverBuffer"), true);
    }
    if (api == RtAudio::WINDOWS_ASIO) asioEntry_ = entry;
    apis.append(entry);
  }
  return QJsonObject{{QStringLiteral("apis"), apis}, {QStringLiteral("current"), status()}};
}

// ── the device's thread ──

int NativeAudio::callback(void *out, void *, unsigned int frames, double, unsigned int status, void *user) {
  static_cast<NativeAudio *>(user)->process(static_cast<float *>(out), frames, status);
  return 0;
}

/** The engine lock, for the callback: spin for at most a quarter of the
 *  period (a command being applied takes microseconds), then give up. */
bool NativeAudio::lockForCallback(unsigned int frames) {
  if (engine_.try_lock()) return true;
  const auto budget = std::chrono::nanoseconds(uint64_t(frames) * 250000000ull / rate_);
  const auto until = Clock::now() + budget;
  while (Clock::now() < until) {
    if (engine_.try_lock()) return true;
    std::this_thread::yield();
  }
  return false;
}

void NativeAudio::process(float *out, unsigned int frames, unsigned int status) {
#ifdef __linux__
  if (callbackTid_.load(std::memory_order_relaxed) == 0) callbackTid_.store(long(syscall(SYS_gettid)));
#endif
  if (!live_.load(std::memory_order_acquire)) {
    std::memset(out, 0, sizeof(float) * 2 * frames);
    return;
  }
#ifdef __linux__
  if (lost_.load(std::memory_order_relaxed)) {
    // Gone, and to be opened again: nothing is rendered meanwhile, so the
    // song does not run on unheard; and where RtAudio's loop now goes round
    // at once (ALSA, PulseAudio: the writes fail), at the device's pace.
    std::memset(out, 0, sizeof(float) * 2 * frames);
    if (paceWhenLost_.load(std::memory_order_relaxed) && rate_ > 0)
      std::this_thread::sleep_for(std::chrono::microseconds(uint64_t(frames) * 1000000u / rate_));
    return;
  }
#endif
  const bool profiling = profiling_.load(std::memory_order_relaxed);
  const auto t0 = Clock::now();
  if (status & RTAUDIO_OUTPUT_UNDERFLOW) xruns_.fetch_add(1, std::memory_order_relaxed);
  if (!lockForCallback(frames)) {
    std::memset(out, 0, sizeof(float) * 2 * frames);
    xruns_.fetch_add(1, std::memory_order_relaxed);
    lockMisses_.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  std::lock_guard<std::mutex> lock(engine_, std::adopt_lock);
  if (host_ == nullptr) {
    std::memset(out, 0, sizeof(float) * 2 * frames);
    return;
  }
  const auto r0 = Clock::now();
  bool rendered;
  if (resampler_.active()) {
    // The engine's frames into the ring, the device's out through the sinc.
    rendered = false;
    for (int need = resampler_.framesWanted(int(frames)); need > 0;) {
      const int n = std::min(need, kScratchFrames);
      const bool r = mt_host_render(host_, scratch_.data(), n) != 0;
      resampler_.push(r ? scratch_.data() : nullptr, n);
      rendered = rendered || r;
      need -= n;
    }
    resampler_.read(out, int(frames));
    rendered = rendered || mt_host_active(host_);
  } else {
    rendered = mt_host_render(host_, out, int(frames)) != 0;
  }
  if (rendered && dumpUsed_ < dumpTarget_) {
    const size_t n = std::min(dumpTarget_ - dumpUsed_, size_t(frames) * 2);
    std::memcpy(dump_.data() + dumpUsed_, out, n * sizeof(float));
    dumpUsed_ += n;
    if (dumpUsed_ == dumpTarget_) dumpFull_ = true;
  }
  if (profiling && rendered) {
    const uint64_t ns = nanosSince(r0);
    pfRenderNs_.fetch_add(ns, std::memory_order_relaxed);
    pfRenderCount_.fetch_add(1, std::memory_order_relaxed);
    storeMax(pfRenderMaxNs_, ns);
    const int voices = mt_host_sounding_voices(host_);
    if (voices > pfPeakVoices_.load(std::memory_order_relaxed)) pfPeakVoices_.store(voices, std::memory_order_relaxed);
  }

  // Snapshots on the page's cadence while something plays; one when it
  // stops; one whenever a command asked for it.
  const bool active = mt_host_active(host_) != 0;
  framesSinceSnap_ += frames;
  const unsigned int every = unsigned(uint64_t(rate_) * unsigned(mt_host_snapshot_interval_ms(host_)) / 1000u);
  if ((active && framesSinceSnap_ >= every) || (wasActive_ && !active) || snapWanted_.exchange(false)) {
    framesSinceSnap_ = 0;
    publishSnapshot();
  }
  wasActive_ = active;

  if (profiling) {
    const uint64_t ns = nanosSince(t0);
    pfProcNs_.fetch_add(ns, std::memory_order_relaxed);
    pfProcCount_.fetch_add(1, std::memory_order_relaxed);
    pfFrames_.fetch_add(frames, std::memory_order_relaxed);
    storeMax(pfProcMaxNs_, ns);
  }
}

/** Under the engine lock, on the callback's thread. */
void NativeAudio::publishSnapshot() {
  Slot &s = slots_[back_];
  mt_host_fill_snapshot(host_, s.f.data(), &s.analysis, &s.meter);
  int32_t args[16] = {};
  const uint32_t drained = mt_host_drain_interrupts(host_, args);
  s.mask = drained | carryMask_;
  for (int n = 0; n < 16; n++) {
    if (drained & (1u << n)) s.args[n] = args[n];
    else if (carryMask_ & (1u << n)) s.args[n] = carryArgs_[n];
  }
  const int prev = mid_.exchange(back_ | kFresh, std::memory_order_acq_rel);
  back_ = prev & 3;
  // The one we replaced was never taken: its interrupts go out with the next.
  if (prev & kFresh) {
    carryMask_ = slots_[back_].mask;
    std::memcpy(carryArgs_, slots_[back_].args, sizeof carryArgs_);
  } else {
    carryMask_ = 0;
  }
}

/** Ask the session's RealtimeKit to schedule the callback's thread FIFO at
 *  the highest priority it allows (it caps that; PipeWire asks it the same
 *  way). It wants a CPU-time limit on real-time threads first, so a runaway
 *  one is stopped rather than freezing the machine: 200 ms, far above a
 *  callback's work. Failing that, the highest ordinary priority it gives. */
void NativeAudio::requestRealtime(long tid) {
#ifdef __linux__
  // Real-time already — JACK's own process thread, or RtAudio's request
  // where the session allows one — is kept as it is: asking RealtimeKit
  // would put a JACK client above the server it runs under.
  {
    const int policy = sched_getscheduler(pid_t(tid)) & ~SCHED_RESET_ON_FORK;
    sched_param p{};
    if ((policy == SCHED_FIFO || policy == SCHED_RR) && sched_getparam(pid_t(tid), &p) == 0) {
      realtime_ = QStringLiteral("%1 %2 (%3's own)")
                      .arg(policy == SCHED_FIFO ? QStringLiteral("SCHED_FIFO") : QStringLiteral("SCHED_RR"))
                      .arg(p.sched_priority)
                      .arg(apiName_);
      return;
    }
  }
  rlimit limit{200000, 200000};  // microseconds
  setrlimit(RLIMIT_RTTIME, &limit);
  const QString service = QStringLiteral("org.freedesktop.RealtimeKit1");
  const QString path = QStringLiteral("/org/freedesktop/RealtimeKit1");
  QDBusInterface props(service, path, QStringLiteral("org.freedesktop.DBus.Properties"), QDBusConnection::systemBus());
  QDBusInterface rtkit(service, path, service, QDBusConnection::systemBus());
  QDBusReply<QDBusVariant> maxPrio = props.call(QStringLiteral("Get"), service, QStringLiteral("MaxRealtimePriority"));
  const quint32 prio = maxPrio.isValid() ? maxPrio.value().variant().toUInt() : 20u;
  QDBusMessage r = rtkit.call(QStringLiteral("MakeThreadRealtime"), quint64(tid), prio);
  if (r.type() != QDBusMessage::ErrorMessage) {
    realtime_ = QStringLiteral("SCHED_FIFO %1 (RealtimeKit)").arg(prio);
    return;
  }
  const QString why = r.errorMessage();
  QDBusReply<QDBusVariant> minNice = props.call(QStringLiteral("Get"), service, QStringLiteral("MinNiceLevel"));
  const int nice = minNice.isValid() ? minNice.value().variant().toInt() : -11;
  r = rtkit.call(QStringLiteral("MakeThreadHighPriority"), quint64(tid), qint32(nice));
  realtime_ = r.type() != QDBusMessage::ErrorMessage
                  ? QStringLiteral("nice %1 (RealtimeKit; real-time refused: %2)").arg(nice).arg(why)
                  : QStringLiteral("none: %1").arg(why);
  qWarning("audio: the callback thread: %s", qUtf8Printable(realtime_));
#else
  Q_UNUSED(tid);
  realtime_ = QStringLiteral("the audio API's own");
#endif
}

// ── the GUI thread ──

void NativeAudio::attach(std::unique_ptr<QWebSocket> socket) {
  if (socket_) {
    socket_->disconnect(this);
    socket_->close();
  }
  socket_ = std::move(socket);
  QWebSocket *ws = socket_.get();
  connect(ws, &QWebSocket::binaryMessageReceived, this, &NativeAudio::onMessage);
  connect(ws, &QWebSocket::disconnected, this, [this, ws] {
    if (socket_.get() == ws) detach();
  });
  sendStatus();
}

void NativeAudio::detach() {
  // The page is gone (closed, reloading): its engine goes with it, as a
  // render Worker would. The next page's INIT builds a fresh one.
  {
    std::lock_guard<std::mutex> lock(engine_);
    mt_host_free(host_);
    host_ = mt_host_new(int(kEngineRate));
  }
  profiling_ = false;
  if (socket_) socket_.release()->deleteLater();
}

void NativeAudio::send(const QByteArray &bytes) {
  if (socket_ && socket_->isValid()) socket_->sendBinaryMessage(bytes);
}

void NativeAudio::sendStatus() {
  QByteArray b = header(kStatus);
  b += QJsonDocument(status()).toJson(QJsonDocument::Compact);
  send(b);
}

void NativeAudio::onMessage(const QByteArray &message) {
  const auto *p = reinterpret_cast<const uint8_t *>(message.constData());
  const auto *end = p + message.size();
  std::vector<QByteArray> replies;
  bool applied = false;
  auto need = [&](size_t n) { return size_t(end - p) >= n; };
  std::unique_lock<std::mutex> lock(engine_, std::defer_lock);
  while (p < end) {
    MtCommand c{};
    if (!need(1)) break;
    c.nameLen = *p++;
    if (!need(size_t(c.nameLen) + 4)) break;
    c.name = reinterpret_cast<const char *>(p);
    p += c.nameLen;
    c.nInts = p[0] | (p[1] << 8);
    c.nDoubles = p[2];
    c.nBlobs = p[3];
    p += 4;
    if (c.nBlobs > 4 || !need(size_t(c.nInts) * 4 + size_t(c.nDoubles) * 8)) break;
    c.ints = reinterpret_cast<const int32_t *>(p);
    p += size_t(c.nInts) * 4;
    c.doubles = reinterpret_cast<const double *>(p);
    p += size_t(c.nDoubles) * 8;
    bool ok = true;
    for (int k = 0; k < c.nBlobs; k++) {
      if (!need(4)) { ok = false; break; }
      const uint32_t len = qFromLittleEndian<uint32_t>(p);
      p += 4;
      if (!need(len)) { ok = false; break; }
      c.blob[k] = p;
      c.blobLen[k] = len;
      p += len;
    }
    if (!ok) break;

    // The host's own requests: the device is closed and opened outside the
    // engine lock (stopping a stream waits for its callback).
    if (named(c.name, c.nameLen, "HOST_DEVICES") || named(c.name, c.nameLen, "HOST_CONFIGURE") ||
        named(c.name, c.nameLen, "HOST_PANEL")) {
      if (lock.owns_lock()) lock.unlock();
      if (named(c.name, c.nameLen, "HOST_DEVICES")) {
        QByteArray b = header(kDevices);
        b += QJsonDocument(devices()).toJson(QJsonDocument::Compact);
        replies.push_back(b);
      } else if (named(c.name, c.nameLen, "HOST_PANEL")) {
        openDriverPanel();
      } else {
        configure(c.nBlobs > 0 ? QByteArray(reinterpret_cast<const char *>(c.blob[0]), qsizetype(c.blobLen[0]))
                               : QByteArray());
      }
      continue;
    }
    if (named(c.name, c.nameLen, "SET_PROFILE")) {
      int32_t on = 0;
      if (c.nInts > 0) std::memcpy(&on, c.ints, 4);
      profiling_ = on != 0;
      pfFrames_ = pfProcNs_ = pfRenderNs_ = pfProcCount_ = pfRenderCount_ = 0;
      pfProcMaxNs_ = pfRenderMaxNs_ = 0;
      pfPeakVoices_ = 0;
      xruns_ = lockMisses_ = 0;
      continue;
    }
    if (!lock.owns_lock()) lock.lock();
    if (host_ == nullptr) continue;
    uint8_t *reply = nullptr;
    size_t replyLen = 0;
    const int r = mt_host_apply(host_, &c, &reply, &replyLen);
    if (r == MT_APPLIED) {
      applied = true;
      // As the worklet flushes its ring: no stale tail plays after a jump,
      // and the sinc's history does not reach back across it.
      if (jumpsTransport(c.name, c.nameLen) && resampler_.active()) resampler_.flush();
    }
    if (r == MT_REPLIED) {
      replies.emplace_back(reinterpret_cast<const char *>(reply), qsizetype(replyLen));
      free(reply);
    }
  }
  if (applied && !running_ && host_ != nullptr) {
    // No device clock to take the snapshot: take it here.
    if (!lock.owns_lock()) lock.lock();
    publishSnapshot();
  }
  if (lock.owns_lock()) lock.unlock();
  if (applied) snapWanted_ = true;  // the callback's next pass reflects it at once
  for (const QByteArray &r : replies) send(r);
}

void NativeAudio::pump() {
#if MICROTONE_WASAPI
  if (wasapi_ != nullptr && mt_wasapi_lost(wasapi_)) lost_ = true;
#endif
  if (lost_ && running_) reopenLost();
  // The system's devices changed: a fresh list, once they have settled (a
  // headset comes in as several notifications) and any reopen is done.
  if (devicesDirty_ && !lost_ && steadyMs() - devicesAtMs_.load() >= 300) {
    devicesDirty_ = false;
    QJsonObject list = devices(false);
    if (openDeviceGone(list)) {
      qInfo("audio: \"%s\" is no longer listed; opening the output again", qUtf8Printable(device_));
      markLost();  // the reopen sends the list
    } else {
      if (returnToChosen(list)) list.insert(QStringLiteral("current"), status());
      qInfo("audio: the system's devices changed; sending the page the list");
      QByteArray b = header(kDevices);
      b += QJsonDocument(list).toJson(QJsonDocument::Compact);
      send(b);
    }
  }
  updateLooks();
  if (!realtimeAsked_ && callbackTid_.load() != 0) {  // RtAudio's thread (WASAPI's has MMCSS)
    realtimeAsked_ = true;
    requestRealtime(callbackTid_.load());
    sendStatus();
  }
  if (dumpFull_ && !dumpWritten_) {
    dumpWritten_ = true;
    QFile f(dumpPath_);
    if (f.open(QIODevice::WriteOnly)) {
      f.write(reinterpret_cast<const char *>(dump_.data()), qint64(dumpUsed_ * sizeof(float)));
      qInfo("microtone: wrote %lld bytes of native audio to %s", qint64(f.size()), qUtf8Printable(dumpPath_));
    }
  }
  const int m = mid_.load(std::memory_order_acquire);
  if (m & kFresh) {
    const int prev = mid_.exchange(front_, std::memory_order_acq_rel);
    front_ = prev & 3;
    sendSnapshot(front_);
  }
  if (profiling_) {
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (now - lastProfileMs_ >= 1000) {
      lastProfileMs_ = now;
      sendProfile();
    }
  }
}

/** The ranges fillSnapshotInto would have copied, as current as the slot:
 *  a meter that is off sends nothing, and the page keeps what it had. */
void NativeAudio::sendSnapshot(int index) {
  const Slot &s = slots_[index];
  const MtSnapLayout &L = layout_;
  std::vector<std::pair<int, int>> ranges;  // [from, to)
  ranges.emplace_back(0, L.interruptMask);
  ranges.emplace_back(L.interruptMask + 1, L.interruptArgs);
  ranges.emplace_back(L.headerSize, L.meterBase);
  if (s.analysis) ranges.emplace_back(L.meterBase, L.mmBase);
  if (s.meter) ranges.emplace_back(L.mmBase, L.imBase);
  // The Mixing tab's seats: an off seat's marker only.
  for (int seat = 0; seat < L.imSeats; seat++) {
    const int base = L.imBase + seat * L.imStride;
    ranges.emplace_back(base, s.f[size_t(base + L.imSlot)] >= 0 ? base + L.imStride : base + L.imSlot + 1);
  }
  const int ep = std::clamp(int(s.f[size_t(L.epCount)]), 0, (L.floats - L.epEntries) / L.epStride);
  ranges.emplace_back(L.epBase, L.epEntries + ep * L.epStride);

  QByteArray b = header(kSnapshot);
  appendU32(b, s.mask);
  for (int n = 0; n < 16; n++) appendU32(b, uint32_t(s.args[n]));
  appendU32(b, uint32_t(ranges.size()));
  for (auto [from, to] : ranges) {
    appendU32(b, uint32_t(from));
    appendU32(b, uint32_t(to - from));
  }
  for (auto [from, to] : ranges) {
    b.append(reinterpret_cast<const char *>(s.f.data() + from), qsizetype(to - from) * 4);
  }
  send(b);
}

/** In the shape of the worklet's own report (render mode: the engine renders
 *  in the audio callback), which the profiler panel already reads:
 *  `sampleRate` the engine's, `step` engine frames per output frame. */
void NativeAudio::sendProfile() {
  const uint64_t frames = pfFrames_.exchange(0), procNs = pfProcNs_.exchange(0), renderNs = pfRenderNs_.exchange(0);
  const uint64_t procCount = pfProcCount_.exchange(0), renderCount = pfRenderCount_.exchange(0);
  const uint64_t procMax = pfProcMaxNs_.exchange(0), renderMax = pfRenderMaxNs_.exchange(0);
  const int peak = pfPeakVoices_.exchange(0);
  uint64_t xruns = xruns_.exchange(0);
  const uint64_t misses = lockMisses_.exchange(0);
#if MICROTONE_WASAPI
  if (wasapi_ != nullptr) {
    const unsigned g = mt_wasapi_glitches(wasapi_);
    xruns += g - wasapiGlitches_;
    wasapiGlitches_ = g;
  }
#endif
  const double audioMs = rate_ ? double(frames) * 1000.0 / rate_ : 0.0;
  const double ms = 1e-6;
  QJsonObject o{
      {QStringLiteral("cpuFrac"), audioMs > 0 ? procNs * ms / audioMs : 0.0},
      {QStringLiteral("renderFrac"), audioMs > 0 ? renderNs * ms / audioMs : 0.0},
      {QStringLiteral("procMeanMs"), procCount ? procNs * ms / double(procCount) : 0.0},
      {QStringLiteral("procMaxMs"), procMax * ms},
      {QStringLiteral("renderMeanMs"), renderCount ? renderNs * ms / double(renderCount) : 0.0},
      {QStringLiteral("renderMaxMs"), renderMax * ms},
      {QStringLiteral("quantumMs"), rate_ ? bufferFrames_ * 1000.0 / rate_ : 0.0},
      {QStringLiteral("xruns"), double(xruns)},
      {QStringLiteral("underruns"), 0},
      {QStringLiteral("lockMisses"), double(misses)},
      {QStringLiteral("procCount"), double(procCount)},
      {QStringLiteral("renderCount"), double(renderCount)},
      {QStringLiteral("peakVoices"), peak},
      {QStringLiteral("memoryBytes"), 0},
      {QStringLiteral("windowMs"), audioMs},
      {QStringLiteral("sampleRate"), int(kEngineRate)},
      {QStringLiteral("step"), rate_ ? double(kEngineRate) / rate_ : 1.0},
      {QStringLiteral("hiResClock"), true},
      {QStringLiteral("clockResMs"), 0.001},
      {QStringLiteral("workerRender"), false},
      {QStringLiteral("native"), status()},
  };
  QByteArray b = header(kProfile);
  b += QJsonDocument(o).toJson(QJsonDocument::Compact);
  send(b);
}

}  // namespace microtone
