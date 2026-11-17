// The native audio host: the C engine (enginehost.c over core/engine/c) on the
// audio device's own callback, driven by the page over a WebSocket.
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
//   page → host  one or more frames: u8 name length, the CMD's name, u16 ints,
//                u8 doubles, u8 blobs, then i32s, f64s and (u32 length, bytes)
//                per blob — the C arguments, lowered by the page
//   host → page  u8 kind + 3 pad, then: 0 HELLO (JSON), 1 SNAPSHOT (interrupt
//                mask + 16 args, ranges, floats), 2 INVERT_MASK (enginehost.c),
//                3 PROFILE (JSON)
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

class RtAudio;
class QWebSocket;

namespace microtone {

class NativeAudio : public QObject {
  Q_OBJECT
 public:
  explicit NativeAudio(QObject *parent = nullptr);
  ~NativeAudio() override;

  /** Open and start an output device. MICROTONE_AUDIO_API (pulse, alsa,
   *  jack, wasapi, asio, core) and MICROTONE_BUFFER_FRAMES override the
   *  defaults. False, with `error` said, when there is none to open. */
  bool start(QString *error);

  /** The page's connection; a new one (a reload) replaces the old. */
  void attach(std::unique_ptr<QWebSocket> socket);

  QJsonObject status() const;

 private:
  static int callback(void *out, void *in, unsigned int frames, double time, unsigned int status, void *user);
  void process(float *out, unsigned int frames, unsigned int status);
  bool lockForCallback(unsigned int frames);
  void publishSnapshot();
  void requestRealtime(long tid);

  void onMessage(const QByteArray &message);
  void pump();
  void sendSnapshot(int slot);
  void sendProfile();
  void send(const QByteArray &bytes);
  void detach();

  std::unique_ptr<RtAudio> dac_;
  QString api_, device_;
  unsigned int rate_ = 48000;
  unsigned int bufferFrames_ = 256;
  bool running_ = false;

  MtHost *host_ = nullptr;
  std::mutex engine_;
  MtSnapLayout layout_{};

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
  std::atomic<long> callbackTid_{0};
  bool realtimeAsked_ = false;
  QString realtime_;  // what was granted, for the profile

  // ── a capture, for checking the host against the WebAssembly engine ──
  // MICROTONE_NATIVE_DUMP=<file> keeps the first MICROTONE_NATIVE_DUMP_SECONDS
  // (default 30) of what the engine rendered — interleaved stereo float, the
  // mix bus, silence between plays left out — and the GUI thread writes it
  // out once full. Preallocated: the callback only copies.
  QString dumpPath_;
  std::vector<float> dump_;
  size_t dumpUsed_ = 0;
  std::atomic<bool> dumpFull_{false};
  bool dumpWritten_ = false;
};

}  // namespace microtone
