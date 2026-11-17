// The native audio host: the C engine (enginehost.c over core/engine/c) on the
// audio device's own callback, driven by the page over a WebSocket.
//
// The engine renders at 48 kHz, as it does in the browser, for its whole life:
// a device at another rate hears it through the web build's own resampler
// (resampler.h). So the output — API, device, rate, buffer — can be changed at
// any time, from the page's Settings tab, without touching the engine: the
// stream is closed and opened again, and playback carries on. A setting that
// fails to open puts the previous one back; one that works is remembered.
//
// Threads. The page's commands arrive on the GUI thread and are applied under
// the engine lock. The device callback renders exactly the frames the device
// asks for (spans of at most a chunk: te_render_frames), taking the same lock;
// it never blocks on it — it spins for at most a quarter of its period, and
// plays silence (counted as an xrun) if a long upload still holds it.
// Snapshots go the other way through a triple buffer, so the callback never
// waits for the GUI either: the newest one wins, and the interrupts of one the
// GUI never collected ride along in the next, so no Int fire is lost.
//
// The wire (native-engine.js has the page's side):
//   page → host  one or more frames: u8 name length, the name, u16 ints,
//                u8 doubles, u8 blobs, then i32s, f64s and (u32 length, bytes)
//                per blob. A CMD's name carries its C arguments, lowered by
//                the page; HOST_DEVICES and HOST_CONFIGURE (a JSON blob) are
//                the host's own.
//   host → page  u8 kind + 3 pad, then: 0 STATUS (JSON: first as the hello,
//                again after every HOST_CONFIGURE), 1 SNAPSHOT (interrupt
//                mask + 16 args, ranges, floats), 2 INVERT_MASK (enginehost.c),
//                3 PROFILE (JSON), 4 DEVICES (JSON)
#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QObject>
#include <QPointer>
#include <QTimer>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

#include "enginehost.h"
#include "resampler.h"

class RtAudio;
class QWebSocket;

namespace microtone {

class NativeAudio : public QObject {
  Q_OBJECT
 public:
  /** The engine's rate: the web build's, fixed. */
  static constexpr unsigned kEngineRate = 48000;

  /** An output setting. Empty api / device = the default; rate 0 = 48 kHz
   *  where the device has it, else its own. */
  struct Config {
    QString api;
    QString device;
    unsigned rate = 0;
    unsigned bufferFrames = 256;
  };

  explicit NativeAudio(QObject *parent = nullptr);
  ~NativeAudio() override;

  /** Open the remembered output, else the first that opens (Linux:
   *  PulseAudio, ALSA, JACK). MICROTONE_AUDIO_API (pulse, alsa, jack,
   *  wasapi, asio, core) and MICROTONE_BUFFER_FRAMES override what is
   *  remembered. False, with `error` said, when nothing opens. */
  bool start(QString *error);

  /** The page's connection; a new one (a reload) replaces the old. */
  void attach(std::unique_ptr<QWebSocket> socket);

  QJsonObject status() const;
  /** Every compiled API's output devices, and what is open now. */
  QJsonObject devices();

 private:
  static int callback(void *out, void *in, unsigned int frames, double time, unsigned int status, void *user);
  void process(float *out, unsigned int frames, unsigned int status);
  bool lockForCallback(unsigned int frames);
  void publishSnapshot();
  void requestRealtime(long tid);

  bool open(const Config &config, QString *error);
  void closeDevice();
  void configure(const QByteArray &json);
  static Config remembered();
  static void remember(const Config &config);

  void onMessage(const QByteArray &message);
  void pump();
  void sendSnapshot(int slot);
  void sendProfile();
  void sendStatus();
  void send(const QByteArray &bytes);
  void detach();

  std::unique_ptr<RtAudio> dac_;
  Config config_;            // what is open, its api and device spelled out
  QString apiName_, device_;
  QString lastError_;        // the last setting that would not open
  unsigned int rate_ = kEngineRate;
  unsigned int bufferFrames_ = 256;
  unsigned int streamLatency_ = 0;
  bool running_ = false;

  MtHost *host_ = nullptr;
  std::mutex engine_;
  MtSnapLayout layout_{};
  RingResampler resampler_;
  std::vector<float> scratch_;  // engine frames on their way into the resampler

  std::unique_ptr<QWebSocket> socket_;
  QTimer pump_;

  // ── the snapshot triple buffer ──
  struct Slot {
    std::vector<float> f;
    uint32_t mask = 0;
    int32_t args[16] = {};
    int analysis = 0, meter = 0;
  };
  static constexpr int kFresh = 4;
  Slot slots_[3];
  int back_ = 0;                // the callback's
  int front_ = 2;               // the GUI's
  std::atomic<int> mid_{1};     // the newest published, | kFresh until taken
  uint32_t carryMask_ = 0;      // interrupts of a published slot nobody took
  int32_t carryArgs_[16] = {};
  std::atomic<bool> snapWanted_{false};
  unsigned int framesSinceSnap_ = 0;
  bool wasActive_ = false;

  // ── the profiler (written by the callback, read and cleared by pump) ──
  std::atomic<bool> profiling_{false};
  std::atomic<uint64_t> pfFrames_{0}, pfProcNs_{0}, pfRenderNs_{0}, pfProcCount_{0}, pfRenderCount_{0};
  std::atomic<uint64_t> pfProcMaxNs_{0}, pfRenderMaxNs_{0};
  std::atomic<int> pfPeakVoices_{0};
  std::atomic<uint64_t> xruns_{0}, lockMisses_{0};
  qint64 lastProfileMs_ = 0;

  // ── real-time scheduling for the callback's thread ──
  // A desktop session gives an ordinary process no real-time priority
  // (RLIMIT_RTPRIO 0), so RtAudio's own request fails and the render is
  // preempted mid-span. On Linux the session's RealtimeKit grants it, as it
  // does PipeWire: the callback notes its thread id, the GUI thread asks.
  // A reopened stream has a thread of its own, and asks again.
  std::atomic<long> callbackTid_{0};
  bool realtimeAsked_ = false;
  QString realtime_;  // what was granted, for the status

  // ── a capture, for checking the host against the WebAssembly engine ──
  // MICROTONE_NATIVE_DUMP=<file> keeps the first MICROTONE_NATIVE_DUMP_SECONDS
  // (default 30) of the device's output while the engine renders —
  // interleaved stereo float — and the GUI thread writes it out once full.
  // Preallocated: the callback only copies.
  QString dumpPath_;
  std::vector<float> dump_;
  size_t dumpUsed_ = 0;
  size_t dumpTarget_ = 0;  // the seconds asked for, at the open stream's rate
  std::atomic<bool> dumpFull_{false};
  bool dumpWritten_ = false;
};

}  // namespace microtone
