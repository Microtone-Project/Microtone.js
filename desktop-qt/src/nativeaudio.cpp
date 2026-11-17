#include "nativeaudio.h"

#include <QDateTime>
#include <QFile>
#include <QJsonDocument>
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
enum : uint8_t { kHello = 0, kSnapshot = 1, kInvertMask = 2, kProfile = 3 };

QByteArray header(uint8_t kind) {
  QByteArray b(4, '\0');
  b[0] = char(kind);
  return b;
}

void appendU32(QByteArray &b, uint32_t v) {
  const uint32_t le = qToLittleEndian(v);
  b.append(reinterpret_cast<const char *>(&le), 4);
}

RtAudio::Api apiFromEnv() {
  const QByteArray want = qgetenv("MICROTONE_AUDIO_API").toLower();
  if (want.isEmpty()) return RtAudio::UNSPECIFIED;
  std::vector<RtAudio::Api> apis;
  RtAudio::getCompiledApi(apis);
  for (RtAudio::Api api : apis) {
    if (want == QByteArray::fromStdString(RtAudio::getApiName(api))) return api;
  }
  return RtAudio::UNSPECIFIED;
}

/** Linux: PulseAudio first (PipeWire answers it, and it follows the desktop's
 *  own choice of output), then ALSA, then JACK; elsewhere RtAudio's order. */
std::vector<RtAudio::Api> apiOrder() {
  std::vector<RtAudio::Api> compiled;
  RtAudio::getCompiledApi(compiled);
  const RtAudio::Api forced = apiFromEnv();
  if (forced != RtAudio::UNSPECIFIED) return {forced};
  std::vector<RtAudio::Api> order;
  for (RtAudio::Api preferred : {RtAudio::LINUX_PULSE, RtAudio::LINUX_ALSA, RtAudio::UNIX_JACK}) {
    if (std::find(compiled.begin(), compiled.end(), preferred) != compiled.end()) order.push_back(preferred);
  }
  for (RtAudio::Api api : compiled) {
    if (std::find(order.begin(), order.end(), api) == order.end()) order.push_back(api);
  }
  return order;
}

}  // namespace

NativeAudio::NativeAudio(QObject *parent) : QObject(parent) {
  mt_snap_layout(&layout_);
  for (Slot &s : slots_) s.f.assign(size_t(layout_.floats), 0.0f);
  pump_.setInterval(4);
  connect(&pump_, &QTimer::timeout, this, &NativeAudio::pump);
}

NativeAudio::~NativeAudio() {
  pump_.stop();
  if (dac_) {
    if (dac_->isStreamRunning()) dac_->stopStream();
    if (dac_->isStreamOpen()) dac_->closeStream();
  }
  std::lock_guard<std::mutex> lock(engine_);
  mt_host_free(host_);
  host_ = nullptr;
}

bool NativeAudio::start(QString *error) {
  const unsigned int wantFrames = qEnvironmentVariableIntValue("MICROTONE_BUFFER_FRAMES") > 0
                                      ? unsigned(qEnvironmentVariableIntValue("MICROTONE_BUFFER_FRAMES"))
                                      : 256;
  QString why;
  for (RtAudio::Api api : apiOrder()) {
    auto dac = std::make_unique<RtAudio>(api, [](RtAudioErrorType, const std::string &text) {
      qWarning("microtone: audio: %s", text.c_str());
    });
    const unsigned int id = dac->getDefaultOutputDevice();
    if (id == 0) {
      why = QStringLiteral("no output device for %1").arg(QString::fromStdString(RtAudio::getApiDisplayName(api)));
      continue;
    }
    const RtAudio::DeviceInfo info = dac->getDeviceInfo(id);
    // 48 kHz, the web build's rate, where the device has it.
    unsigned int rate = 48000;
    if (!info.sampleRates.empty() && std::find(info.sampleRates.begin(), info.sampleRates.end(), rate) == info.sampleRates.end())
      rate = info.preferredSampleRate ? info.preferredSampleRate : info.sampleRates.back();
    RtAudio::StreamParameters out;
    out.deviceId = id;
    out.nChannels = 2;
    RtAudio::StreamOptions options;
    options.flags = RTAUDIO_SCHEDULE_REALTIME;
    options.streamName = "Microtone";
    unsigned int frames = wantFrames;
    if (dac->openStream(&out, nullptr, RTAUDIO_FLOAT32, rate, &frames, &NativeAudio::callback, this, &options) !=
        RTAUDIO_NO_ERROR) {
      why = QString::fromStdString(dac->getErrorText());
      continue;
    }
    rate_ = dac->getStreamSampleRate();
    bufferFrames_ = frames;
    api_ = QString::fromStdString(RtAudio::getApiDisplayName(api));
    device_ = QString::fromStdString(info.name);
    {
      std::lock_guard<std::mutex> lock(engine_);
      host_ = mt_host_new(int(rate_));
    }
    if (host_ == nullptr || dac->startStream() != RTAUDIO_NO_ERROR) {
      why = host_ == nullptr ? QStringLiteral("out of memory") : QString::fromStdString(dac->getErrorText());
      if (dac->isStreamOpen()) dac->closeStream();
      continue;
    }
    dumpPath_ = qEnvironmentVariable("MICROTONE_NATIVE_DUMP");
    if (!dumpPath_.isEmpty()) {
      const int seconds = qEnvironmentVariableIntValue("MICROTONE_NATIVE_DUMP_SECONDS");
      dump_.assign(size_t(rate_) * size_t(seconds > 0 ? seconds : 30) * 2, 0.0f);
    }
    dac_ = std::move(dac);
    running_ = true;
    pump_.start();
    return true;
  }
  if (error) *error = why.isEmpty() ? QStringLiteral("no audio API was compiled in") : why;
  return false;
}

QJsonObject NativeAudio::status() const {
  return QJsonObject{
      {QStringLiteral("ok"), running_},
      {QStringLiteral("api"), api_},
      {QStringLiteral("device"), device_},
      {QStringLiteral("rate"), int(rate_)},
      {QStringLiteral("bufferFrames"), int(bufferFrames_)},
      {QStringLiteral("realtime"), realtime_},
  };
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
  const bool rendered = mt_host_render(host_, out, int(frames)) != 0;
  if (rendered && dumpUsed_ < dump_.size()) {
    const size_t n = std::min(dump_.size() - dumpUsed_, size_t(frames) * 2);
    std::memcpy(dump_.data() + dumpUsed_, out, n * sizeof(float));
    dumpUsed_ += n;
    if (dumpUsed_ == dump_.size()) dumpFull_ = true;
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
  QByteArray hello = header(kHello);
  hello += QJsonDocument(status()).toJson(QJsonDocument::Compact);
  send(hello);
}

void NativeAudio::detach() {
  // The page is gone (closed, reloading): its engine goes with it, as a
  // render Worker would. The next page's INIT builds a fresh one.
  {
    std::lock_guard<std::mutex> lock(engine_);
    if (host_ != nullptr) {
      const int rate = mt_host_rate(host_);
      mt_host_free(host_);
      host_ = mt_host_new(rate);
    }
  }
  profiling_ = false;
  if (socket_) socket_.release()->deleteLater();
}

void NativeAudio::send(const QByteArray &bytes) {
  if (socket_ && socket_->isValid()) socket_->sendBinaryMessage(bytes);
}

void NativeAudio::onMessage(const QByteArray &message) {
  const auto *p = reinterpret_cast<const uint8_t *>(message.constData());
  const auto *end = p + message.size();
  std::vector<QByteArray> replies;
  bool applied = false;
  auto need = [&](size_t n) { return size_t(end - p) >= n; };
  std::unique_lock<std::mutex> lock(engine_);
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

    if (c.nameLen == 11 && std::memcmp(c.name, "SET_PROFILE", 11) == 0) {
      int32_t on = 0;
      if (c.nInts > 0) std::memcpy(&on, c.ints, 4);
      profiling_ = on != 0;
      pfFrames_ = pfProcNs_ = pfRenderNs_ = pfProcCount_ = pfRenderCount_ = 0;
      pfProcMaxNs_ = pfRenderMaxNs_ = 0;
      pfPeakVoices_ = 0;
      xruns_ = lockMisses_ = 0;
      continue;
    }
    if (host_ == nullptr) continue;
    uint8_t *reply = nullptr;
    size_t replyLen = 0;
    const int r = mt_host_apply(host_, &c, &reply, &replyLen);
    if (r == MT_APPLIED) applied = true;
    if (r == MT_REPLIED) {
      replies.emplace_back(reinterpret_cast<const char *>(reply), qsizetype(replyLen));
      free(reply);
    }
  }
  if (applied && !running_ && host_ != nullptr) {
    // No device clock to take the snapshot: take it here.
    publishSnapshot();
  }
  lock.unlock();
  if (applied) snapWanted_ = true;  // the callback's next pass reflects it at once
  for (const QByteArray &r : replies) send(r);
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
  realtime_ = r.type() != QDBusMessage::ErrorMessage ? QStringLiteral("nice %1 (RealtimeKit; real-time refused: %2)").arg(nice).arg(why)
                                                       : QStringLiteral("none: %1").arg(why);
  qWarning("microtone: audio thread: %s", qUtf8Printable(realtime_));
#else
  Q_UNUSED(tid);
#endif
}

void NativeAudio::pump() {
  if (!realtimeAsked_ && callbackTid_.load() != 0) {
    realtimeAsked_ = true;
    requestRealtime(callbackTid_.load());
  }
  if (dumpFull_ && !dumpWritten_) {
    dumpWritten_ = true;
    QFile f(dumpPath_);
    if (f.open(QIODevice::WriteOnly)) {
      f.write(reinterpret_cast<const char *>(dump_.data()), qint64(dump_.size() * sizeof(float)));
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
 *  in the audio callback), which the profiler panel already reads. */
void NativeAudio::sendProfile() {
  const uint64_t frames = pfFrames_.exchange(0), procNs = pfProcNs_.exchange(0), renderNs = pfRenderNs_.exchange(0);
  const uint64_t procCount = pfProcCount_.exchange(0), renderCount = pfRenderCount_.exchange(0);
  const uint64_t procMax = pfProcMaxNs_.exchange(0), renderMax = pfRenderMaxNs_.exchange(0);
  const int peak = pfPeakVoices_.exchange(0);
  const uint64_t xruns = xruns_.exchange(0), misses = lockMisses_.exchange(0);
  const double audioMs = rate_ ? double(frames) * 1000.0 / rate_ : 0.0;
  const double ms = 1e-6;
  QJsonObject o{
      {QStringLiteral("t"), QStringLiteral("native")},
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
      {QStringLiteral("sampleRate"), int(rate_)},
      {QStringLiteral("step"), int(bufferFrames_)},
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
