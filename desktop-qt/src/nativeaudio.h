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
//                the page; HOST_DEVICES, HOST_CONFIGURE (a JSON blob) and
//                HOST_PANEL (the ASIO driver's settings window) are the
//                host's own.
//   host → page  u8 kind + 3 pad, then: 0 STATUS (JSON: first as the hello,
//                again after every HOST_CONFIGURE), 1 SNAPSHOT (interrupt
//                mask + 16 args, ranges, floats), 2 INVERT_MASK (enginehost.c),
//                3 PROFILE (JSON), 4 DEVICES (JSON)
//
// A device that goes away — unplugged, or an ASIO driver asking to be reset
// because its own panel changed the buffer or the rate — is opened again with
// the same setting (the defaults when that will not open), and the page is
// told.
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
#if MICROTONE_WASAPI
#include "wasapi.h"
#endif

class RtAudio;
class QWebSocket;

namespace microtone {

class NativeAudio : public QObject {
  Q_OBJECT
 public:
  /** The engine's rate: the web build's, fixed. */
  static constexpr unsigned kEngineRate = 48000;

  /** An output setting. Empty api / device = the default; rate 0 = 48 kHz
   *  where the device has it, else its own. `device` is what the API names a
   *  device by: RtAudio's name, WASAPI's endpoint id. `mode` is WASAPI's:
   *  "shared", "lowLatency" or "exclusive" (empty elsewhere). bufferFrames 0
   *  is the driver's own size (ASIO: what its panel is set to); elsewhere it
   *  means 256. */
  struct Config {
    QString api;
    QString device;
    unsigned rate = 0;
    unsigned bufferFrames = 256;
    QString mode;
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
  /** Every compiled API's output devices, and what is open now. `full`
   *  false (a list pushed after a device event) keeps the last ASIO list:
   *  probing ASIO loads every driver, and its list only changes when a driver
   *  is installed. */
  QJsonObject devices(bool full = true);

  /** RtAudio's word that the open device went away, or that its driver asked
   *  to be reset. Any thread: the GUI thread's pump opens it again. */
  void deviceLost();
  /** The system's default output changed (headphones in, another device
   *  chosen in the Sound settings: macOS, Windows). Followed when "the
   *  default" is what is open. Any thread. */
  void defaultOutputChanged();
  /** The system's devices changed (one plugged in or out): the page is sent
   *  a fresh list once they settle. Any thread. */
  void devicesChanged();

 private:
  static int callback(void *out, void *in, unsigned int frames, double time, unsigned int status, void *user);
  void process(float *out, unsigned int frames, unsigned int status);
  bool lockForCallback(unsigned int frames);
  void publishSnapshot();
  void requestRealtime(long tid);

  bool open(const Config &config, QString *error);
  bool openDefaults(unsigned bufferFrames, unsigned rate, QString *error);
  bool openRtAudio(const Config &config, QString *error);
  void closeDevice();
  void reopenLost();
  bool closerDone(unsigned ms);
  bool openOne(const Config &config, QString *error);
  void markLost();
  void markOpening(const Config &config);
  void clearOpening();
  void openDriverPanel();
#if MICROTONE_WASAPI
  bool openWasapi(const Config &config, QString *error);
  static void wasapiRender(void *user, float *out, int frames);
  static void wasapiNotify(void *user, MtWasapiChange change);
#endif
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
  QString recovered_;        // what the last run died opening (start skipped it)
  unsigned openGeneration_ = 0;  // the open the "opening" mark belongs to
  unsigned int rate_ = kEngineRate;
  unsigned int bufferFrames_ = 256;
  unsigned int streamLatency_ = 0;
  double latencyMs_ = 0.0;   // where the API reports it whole (WASAPI)
  QString format_;           // the device's sample format, where the host meets it (WASAPI exclusive, ASIO)
  bool running_ = false;
  // ASIO: the open driver's buffer sizes (asiodriver.h), for the tab.
  bool driverPanel_ = false;
  long bufMin_ = 0, bufMax_ = 0, bufStep_ = 0, bufPreferred_ = 0;
  // The open device went away (deviceLost); on Windows, the RtAudio thread
  // still closing it, which the reopen waits for.
  std::atomic<bool> lost_{false};
  std::atomic<int64_t> lostAtMs_{0};       // steady clock, for the settling wait
  std::atomic<bool> followsDefault_{false};  // macOS: "the default" is open
  std::atomic<bool> devicesDirty_{false};    // a fresh list is owed to the page
  std::atomic<int64_t> devicesAtMs_{0};
  std::atomic<void *> closer_{nullptr};
  unsigned long guiThread_ = 0;
  qint64 lastReopenMs_ = 0;
  // The stream is set up: until then the callback plays silence. A WASAPI
  // stream starts inside its open, before the host has its rate.
  std::atomic<bool> live_{false};
#if MICROTONE_WASAPI
  MtWasapiStream *wasapi_ = nullptr;
  unsigned wasapiGlitches_ = 0;
  MtWasapiWatch *watch_ = nullptr;  // the system's word on device changes
#endif
  QJsonObject asioEntry_;           // devices(): the last full ASIO list

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
