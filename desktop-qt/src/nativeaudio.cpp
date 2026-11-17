#include "nativeaudio.h"

#include <QDateTime>
#include <QFile>
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
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

#include "RtAudio.h"

namespace microtone {

namespace {

using Clock = std::chrono::steady_clock;

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
    if (std::find(order.begin(), order.end(), api) == order.end()) order.push_back(api);
  }
  return order;
}

std::unique_ptr<RtAudio> makeDac(RtAudio::Api api) {
  return std::make_unique<RtAudio>(api, [](RtAudioErrorType type, const std::string &text) {
    if (type != RTAUDIO_WARNING) qWarning("microtone: audio: %s", text.c_str());
  });
}

}  // namespace

NativeAudio::NativeAudio(QObject *parent) : QObject(parent) {
  mt_snap_layout(&layout_);
  for (Slot &s : slots_) s.f.assign(size_t(layout_.floats), 0.0f);
  scratch_.assign(size_t(kScratchFrames) * 2, 0.0f);
  host_ = mt_host_new(int(kEngineRate));
  pump_.setInterval(4);
  connect(&pump_, &QTimer::timeout, this, &NativeAudio::pump);
}

NativeAudio::~NativeAudio() {
  pump_.stop();
  closeDevice();
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
  return c;
}

void NativeAudio::remember(const Config &c) {
  QSettings s;
  s.setValue(QStringLiteral("audio/api"), c.api);
  s.setValue(QStringLiteral("audio/device"), c.device);
  s.setValue(QStringLiteral("audio/rate"), c.rate);
  s.setValue(QStringLiteral("audio/bufferFrames"), c.bufferFrames);
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
  if (wanted.bufferFrames == 0) wanted.bufferFrames = 256;

  dumpPath_ = qEnvironmentVariable("MICROTONE_NATIVE_DUMP");
  if (!dumpPath_.isEmpty()) {
    const int seconds = qEnvironmentVariableIntValue("MICROTONE_NATIVE_DUMP_SECONDS");
    dump_.assign(size_t(192000) * size_t(seconds > 0 ? seconds : 30) * 2, 0.0f);  // any device rate
  }

  QString why;
  if (open(wanted, &why)) {
    pump_.start();
    return true;
  }
  // What was remembered is gone (unplugged, another machine): the defaults.
  for (RtAudio::Api api : apiOrder()) {
    Config c;
    c.api = QString::fromStdString(RtAudio::getApiName(api));
    c.bufferFrames = wanted.bufferFrames;
    if (open(c, &why)) {
      pump_.start();
      return true;
    }
  }
  if (error) *error = why.isEmpty() ? QStringLiteral("no audio API was compiled in") : why;
  return false;
}

void NativeAudio::closeDevice() {
  if (dac_) {
    if (dac_->isStreamRunning()) dac_->stopStream();
    if (dac_->isStreamOpen()) dac_->closeStream();
  }
  running_ = false;
}

/** Open `want` (closing what is open first). On success the host's state
 *  follows the new stream; on failure nothing is open. */
bool NativeAudio::open(const Config &want, QString *error) {
  closeDevice();
  RtAudio::Api api = apiNamed(want.api);
  if (api == RtAudio::UNSPECIFIED) api = apiOrder().empty() ? RtAudio::UNSPECIFIED : apiOrder().front();
  if (!dac_ || dac_->getCurrentApi() != api) {
    dac_.reset();
    dac_ = makeDac(api);
  }
  const QString apiName = QString::fromStdString(RtAudio::getApiDisplayName(api));

  // The device by name (ids are not stable across runs); none, or one that
  // has gone, is the system's default output.
  unsigned int id = 0;
  RtAudio::DeviceInfo info;
  for (unsigned int candidate : dac_->getDeviceIds()) {
    const RtAudio::DeviceInfo i = dac_->getDeviceInfo(candidate);
    if (i.outputChannels >= 2 && !want.device.isEmpty() && QString::fromStdString(i.name) == want.device) {
      id = candidate;
      info = i;
      break;
    }
  }
  if (id == 0) {
    id = dac_->getDefaultOutputDevice();
    if (id != 0) info = dac_->getDeviceInfo(id);
  }
  if (id == 0) {
    if (error) *error = QStringLiteral("no output device for %1").arg(apiName);
    return false;
  }

  unsigned int rate = want.rate;
  const auto has = [&](unsigned int r) {
    return info.sampleRates.empty() || std::find(info.sampleRates.begin(), info.sampleRates.end(), r) != info.sampleRates.end();
  };
  if (rate == 0 || !has(rate)) {
    rate = has(kEngineRate) ? kEngineRate : info.preferredSampleRate ? info.preferredSampleRate : info.sampleRates.back();
  }

  RtAudio::StreamParameters out;
  out.deviceId = id;
  out.nChannels = 2;
  RtAudio::StreamOptions options;
  options.flags = RTAUDIO_SCHEDULE_REALTIME;
  options.streamName = "Microtone";
  unsigned int frames = want.bufferFrames ? want.bufferFrames : 256;
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
  config_ = Config{QString::fromStdString(RtAudio::getApiName(api)), want.device, want.rate, want.bufferFrames};
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

  if (dac_->startStream() != RTAUDIO_NO_ERROR) {
    if (error) *error = QString::fromStdString(dac_->getErrorText());
    dac_->closeStream();
    return false;
  }
  running_ = true;
  return true;
}

/** HOST_CONFIGURE: the page's Settings tab asks for another output. It is
 *  opened at once; if it will not open, the one before comes back. */
void NativeAudio::configure(const QByteArray &json) {
  const QJsonObject o = QJsonDocument::fromJson(json).object();
  Config want;
  want.api = o.value(QStringLiteral("api")).toString();
  want.device = o.value(QStringLiteral("device")).toString();
  want.rate = unsigned(std::max(0, o.value(QStringLiteral("rate")).toInt()));
  want.bufferFrames = unsigned(std::clamp(o.value(QStringLiteral("bufferFrames")).toInt(256), 16, 8192));
  const Config before = config_;
  QString why;
  if (open(want, &why)) {
    lastError_.clear();
    remember(config_);
  } else {
    lastError_ = why.isEmpty() ? QStringLiteral("the device would not open") : why;
    QString again;
    if (!open(before, &again)) {
      // Not even the old one: the defaults, rather than no sound at all.
      for (RtAudio::Api api : apiOrder()) {
        Config c;
        c.api = QString::fromStdString(RtAudio::getApiName(api));
        if (open(c, &again)) break;
      }
    }
  }
  sendStatus();
}

QJsonObject NativeAudio::status() const {
  const double ms = rate_ ? 1000.0 / rate_ : 0.0;
  return QJsonObject{
      {QStringLiteral("ok"), running_},
      {QStringLiteral("api"), apiName_},
      {QStringLiteral("apiId"), config_.api},
      {QStringLiteral("device"), device_},
      {QStringLiteral("deviceChoice"), config_.device},
      {QStringLiteral("rate"), int(rate_)},
      {QStringLiteral("rateChoice"), int(config_.rate)},
      {QStringLiteral("engineRate"), int(kEngineRate)},
      {QStringLiteral("bufferFrames"), int(bufferFrames_)},
      {QStringLiteral("bufferMs"), bufferFrames_ * ms},
      {QStringLiteral("latencyMs"), (bufferFrames_ + streamLatency_) * ms},
      {QStringLiteral("realtime"), realtime_},
      {QStringLiteral("error"), lastError_},
  };
}

QJsonObject NativeAudio::devices() {
  QJsonArray apis;
  for (RtAudio::Api api : apiOrder()) {
    // The open API answers through its own instance: probing a device it
    // holds from a second one can fail.
    std::unique_ptr<RtAudio> temp;
    RtAudio *dac = dac_ && dac_->getCurrentApi() == api ? dac_.get() : (temp = makeDac(api)).get();
    QJsonArray list;
    for (unsigned int id : dac->getDeviceIds()) {
      const RtAudio::DeviceInfo info = dac->getDeviceInfo(id);
      if (info.outputChannels < 2) continue;
      QJsonArray rates;
      for (unsigned int r : info.sampleRates) rates.append(int(r));
      list.append(QJsonObject{
          {QStringLiteral("name"), QString::fromStdString(info.name)},
          {QStringLiteral("isDefault"), info.isDefaultOutput},
          {QStringLiteral("rates"), rates},
          {QStringLiteral("preferredRate"), int(info.preferredSampleRate)},
      });
    }
    apis.append(QJsonObject{
        {QStringLiteral("id"), QString::fromStdString(RtAudio::getApiName(api))},
        {QStringLiteral("name"), QString::fromStdString(RtAudio::getApiDisplayName(api))},
        {QStringLiteral("devices"), list},
    });
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
  qWarning("microtone: audio thread: %s", qUtf8Printable(realtime_));
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
    if (named(c.name, c.nameLen, "HOST_DEVICES") || named(c.name, c.nameLen, "HOST_CONFIGURE")) {
      if (lock.owns_lock()) lock.unlock();
      if (named(c.name, c.nameLen, "HOST_DEVICES")) {
        QByteArray b = header(kDevices);
        b += QJsonDocument(devices()).toJson(QJsonDocument::Compact);
        replies.push_back(b);
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
  if (!realtimeAsked_ && callbackTid_.load() != 0) {
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
  const uint64_t xruns = xruns_.exchange(0), misses = lockMisses_.exchange(0);
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
