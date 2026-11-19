#include "linuxaudiowatch.h"

#include <QFileSystemWatcher>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <string>

#if defined(__LINUX_PULSE__)
#include <pulse/pulseaudio.h>
#endif
#if defined(__UNIX_JACK__)
#include <jack/jack.h>
#endif

namespace microtone {

// ── PulseAudio ──

#if defined(__LINUX_PULSE__)
/** A context on a threaded main loop of its own, subscribed to sinks and the
 *  server. A server that is not there, or goes, is looked for again: after
 *  2 s, then less often, up to every 30 s. */
struct LinuxAudioWatch::Pulse {
  Hooks *hooks = nullptr;
  pa_threaded_mainloop *loop = nullptr;
  pa_context *ctx = nullptr;
  pa_time_event *retry = nullptr;
  std::string defaultSink;
  bool knowsDefault = false;  // the first answer is what it was, not a change
  bool ready = false;      // the context is connected now
  bool wasReady = false;   // …and was at some time: a return is news
  bool stopping = false;
  unsigned retryMs = 2000;

  explicit Pulse(Hooks *h) : hooks(h) {
    loop = pa_threaded_mainloop_new();
    if (loop == nullptr) return;
    pa_threaded_mainloop_lock(loop);
    connect();
    pa_threaded_mainloop_unlock(loop);
    if (pa_threaded_mainloop_start(loop) < 0) {
      pa_threaded_mainloop_free(loop);
      loop = nullptr;
    }
  }

  ~Pulse() {
    if (loop == nullptr) return;
    pa_threaded_mainloop_lock(loop);
    stopping = true;
    pa_mainloop_api *api = pa_threaded_mainloop_get_api(loop);
    if (retry != nullptr) api->time_free(retry);
    retry = nullptr;
    if (ctx != nullptr) {
      pa_context_set_state_callback(ctx, nullptr, nullptr);
      pa_context_set_subscribe_callback(ctx, nullptr, nullptr);
      pa_context_disconnect(ctx);
      pa_context_unref(ctx);
      ctx = nullptr;
    }
    pa_threaded_mainloop_unlock(loop);
    pa_threaded_mainloop_stop(loop);
    pa_threaded_mainloop_free(loop);
  }

  // Everything below runs on the loop's thread, or under its lock.

  void connect() {
    pa_proplist *props = pa_proplist_new();
    pa_proplist_sets(props, PA_PROP_APPLICATION_NAME, "Microtone");
    pa_proplist_sets(props, PA_PROP_APPLICATION_ID, "cc.microtone.desktop");
    ctx = pa_context_new_with_proplist(pa_threaded_mainloop_get_api(loop), "Microtone (device watch)", props);
    pa_proplist_free(props);
    if (ctx == nullptr) return;
    pa_context_set_state_callback(ctx, &Pulse::onState, this);
    // Never start a server: a desktop without one is not ours to change.
    if (pa_context_connect(ctx, nullptr, PA_CONTEXT_NOAUTOSPAWN, nullptr) < 0) scheduleRetry();
  }

  void scheduleRetry() {
    if (stopping || retry != nullptr) return;
    pa_mainloop_api *api = pa_threaded_mainloop_get_api(loop);
    timeval tv;
    pa_gettimeofday(&tv);
    pa_timeval_add(&tv, pa_usec_t(retryMs) * 1000);
    retry = api->time_new(api, &tv, &Pulse::onRetry, this);
    retryMs = std::min(retryMs * 2, 30000u);
  }

  static void onRetry(pa_mainloop_api *api, pa_time_event *e, const timeval *, void *user) {
    auto *self = static_cast<Pulse *>(user);
    api->time_free(e);
    self->retry = nullptr;
    if (self->ctx != nullptr) {
      pa_context_set_state_callback(self->ctx, nullptr, nullptr);
      pa_context_unref(self->ctx);
      self->ctx = nullptr;
    }
    self->connect();
  }

  static void onState(pa_context *c, void *user) {
    auto *self = static_cast<Pulse *>(user);
    switch (pa_context_get_state(c)) {
      case PA_CONTEXT_READY: {
        self->ready = true;
        self->retryMs = 2000;
        pa_context_set_subscribe_callback(c, &Pulse::onEvent, self);
        if (pa_operation *op = pa_context_subscribe(
                c, pa_subscription_mask_t(PA_SUBSCRIPTION_MASK_SINK | PA_SUBSCRIPTION_MASK_SERVER), nullptr, nullptr))
          pa_operation_unref(op);
        if (pa_operation *op = pa_context_get_server_info(c, &Pulse::onServerInfo, self)) pa_operation_unref(op);
        // Back after going: its sinks are news. (The first connection is
        // not: the list was read with the app's start.)
        if (self->wasReady) self->hooks->devices();
        self->wasReady = true;
        break;
      }
      case PA_CONTEXT_FAILED:
      case PA_CONTEXT_TERMINATED:
        if (self->ready) self->hooks->devices();  // its sinks are gone from the list
        self->ready = false;
        self->scheduleRetry();
        break;
      default:
        break;
    }
  }

  static void onServerInfo(pa_context *, const pa_server_info *info, void *user) {
    auto *self = static_cast<Pulse *>(user);
    const std::string sink = info != nullptr && info->default_sink_name != nullptr ? info->default_sink_name : "";
    const bool first = !self->knowsDefault;
    self->knowsDefault = true;
    if (sink == self->defaultSink) return;
    self->defaultSink = sink;
    if (first) return;  // what it was when the watch began
    self->hooks->defaultOutput();
    self->hooks->devices();  // the "default" mark moved
  }

  static void onEvent(pa_context *c, pa_subscription_event_type_t t, uint32_t, void *user) {
    auto *self = static_cast<Pulse *>(user);
    const unsigned facility = t & PA_SUBSCRIPTION_EVENT_FACILITY_MASK;
    const unsigned type = t & PA_SUBSCRIPTION_EVENT_TYPE_MASK;
    if (facility == PA_SUBSCRIPTION_EVENT_SINK) {
      // A sink's own changes (its volume, every time someone moves it) are
      // not the list's.
      if (type == PA_SUBSCRIPTION_EVENT_NEW || type == PA_SUBSCRIPTION_EVENT_REMOVE) self->hooks->devices();
    } else if (facility == PA_SUBSCRIPTION_EVENT_SERVER) {
      if (pa_operation *op = pa_context_get_server_info(c, &Pulse::onServerInfo, self)) pa_operation_unref(op);
    }
  }
};
#else
struct LinuxAudioWatch::Pulse {
  explicit Pulse(Hooks *) {}
};
#endif

// ── JACK ──

#if defined(__UNIX_JACK__)
namespace {
void jackQuiet(const char *) {}

/** Is a JACK server there? (PipeWire's JACK always is.) */
bool jackUp() {
  jack_status_t status;
  jack_client_t *c = jack_client_open("Microtone (looking)", JackNoStartServer, &status);
  if (c == nullptr) return false;
  jack_client_close(c);
  return true;
}
}  // namespace

struct LinuxAudioWatch::Jack {
  Hooks *hooks = nullptr;
  jack_client_t *client = nullptr;
  std::string device;
  unsigned rate = 0, frames = 0;
  std::atomic<bool> told{false};  // the stream is being opened again: once is enough

  Jack(Hooks *h, const std::string &dev, unsigned r, unsigned f) : hooks(h), device(dev), rate(r), frames(f) {
    jack_status_t status;
    client = jack_client_open("Microtone (device watch)", JackNoStartServer, &status);
    if (client == nullptr) return;
    jack_set_client_registration_callback(client, &Jack::onClient, this);
    jack_set_port_registration_callback(client, &Jack::onPort, this);
    jack_set_buffer_size_callback(client, &Jack::onBufferSize, this);
    jack_set_sample_rate_callback(client, &Jack::onRate, this);
    jack_on_shutdown(client, &Jack::onShutdown, this);
    if (jack_activate(client) != 0) {
      jack_client_close(client);
      client = nullptr;
    }
  }

  ~Jack() {
    if (client != nullptr) jack_client_close(client);  // waits for its threads
  }

  void lost() {
    if (!told.exchange(true)) hooks->lost();
  }

  // On JACK's notification thread.
  static void onClient(const char *name, int registered, void *user) {
    auto *self = static_cast<Jack *>(user);
    if (name == nullptr) return;
    // Our own passing clients are no news — RtAudio lists JACK's devices
    // through one ("RtApiJackProbe"), so a list made because of one would
    // make the next.
    if (std::strncmp(name, "RtApiJackProbe", 14) == 0 || std::strncmp(name, "Microtone (", 11) == 0) return;
    // What the stream is connected to went away: it plays into nothing.
    if (!registered && self->device == name) self->lost();
    self->hooks->devices();
  }
  static void onPort(jack_port_id_t, int, void *user) { static_cast<Jack *>(user)->hooks->devices(); }
  static int onBufferSize(jack_nframes_t n, void *user) {
    auto *self = static_cast<Jack *>(user);
    if (n != self->frames) self->lost();  // RtAudio's callback stops at a new size
    return 0;
  }
  static int onRate(jack_nframes_t n, void *user) {
    auto *self = static_cast<Jack *>(user);
    if (n != self->rate) self->lost();  // …and plays on at the old rate, out of tune
    return 0;
  }
  static void onShutdown(void *user) {
    auto *self = static_cast<Jack *>(user);
    self->lost();
    self->hooks->devices();
  }
};
#else
struct LinuxAudioWatch::Jack {
  Jack(Hooks *, const std::string &, unsigned, unsigned) {}
};
#endif

// ── the watch ──

LinuxAudioWatch::LinuxAudioWatch(Hooks hooks, QObject *parent) : QObject(parent), hooks_(std::move(hooks)) {
#if defined(__UNIX_JACK__)
  // Process-wide, as RtAudio sets them: a look for a server that is not
  // there is not an error.
  jack_set_error_function(&jackQuiet);
  jack_set_info_function(&jackQuiet);
#endif
  pulse_ = std::make_unique<Pulse>(&hooks_);
  // A card plugged in or out adds or removes its nodes here (several each).
  snd_ = new QFileSystemWatcher(this);
  if (snd_->addPath(QStringLiteral("/dev/snd"))) {
    connect(snd_, &QFileSystemWatcher::directoryChanged, this, [this] { hooks_.devices(); });
  }
  jackLook_.setInterval(2000);
  connect(&jackLook_, &QTimer::timeout, this, [this] {
#if defined(__UNIX_JACK__)
    const bool up = jackUp();
    if (up && !jackWasUp_) hooks_.devices();
    jackWasUp_ = up;
#endif
  });
}

LinuxAudioWatch::~LinuxAudioWatch() {
  jackLook_.stop();
  jack_.reset();
  pulse_.reset();
}

void LinuxAudioWatch::watchJack(const std::string &device, unsigned rate, unsigned frames) {
  jack_.reset();
  jack_ = std::make_unique<Jack>(&hooks_, device, rate, frames);
}

void LinuxAudioWatch::unwatchJack() { jack_.reset(); }

void LinuxAudioWatch::lookForJack(bool on) {
#if defined(__UNIX_JACK__)
  if (on == jackLook_.isActive()) return;
  if (on) {
    jackWasUp_ = false;  // a server found at the first look is news too
    jackLook_.start();
  } else {
    jackLook_.stop();
  }
#else
  Q_UNUSED(on);
#endif
}

}  // namespace microtone
