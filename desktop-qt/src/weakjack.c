/* JACK, when the system has it (Linux). RtAudio's JACK backend and the
 * device watch (linuxaudiowatch.cpp) call libjack; linking it would make the
 * app refuse to start where there is no libjack, and a packaged copy must
 * not carry one of its own either: the client library has to be the one
 * that speaks to the system's server — jack2's own, or PipeWire's stand-in.
 * So these are the functions they call, each passing the call on to the
 * system's libjack.so.0, loaded the first time one is called. Without one,
 * no client opens (JackFailure | JackServerFailed), which RtAudio takes as
 * "no JACK server": the JACK list is empty, and nothing else needs JACK.
 *
 * Built in place of linking libjack (CMakeLists.txt). A libjack function
 * RtAudio or the watch starts to call goes here too, or the link fails. */
#include <dlfcn.h>
#include <pthread.h>
#include <stdarg.h>
#include <stddef.h>

#include <jack/jack.h>

static struct {
  jack_client_t *(*client_open)(const char *, jack_options_t, jack_status_t *, ...);
  int (*client_close)(jack_client_t *);
  int (*activate)(jack_client_t *);
  int (*deactivate)(jack_client_t *);
  int (*connect)(jack_client_t *, const char *, const char *);
  jack_nframes_t (*get_buffer_size)(jack_client_t *);
  jack_nframes_t (*get_sample_rate)(jack_client_t *);
  const char **(*get_ports)(jack_client_t *, const char *, const char *, unsigned long);
  void (*on_shutdown)(jack_client_t *, JackShutdownCallback, void *);
  jack_port_t *(*port_by_name)(jack_client_t *, const char *);
  void *(*port_get_buffer)(jack_port_t *, jack_nframes_t);
  void (*port_get_latency_range)(jack_port_t *, jack_latency_callback_mode_t, jack_latency_range_t *);
  const char *(*port_name)(const jack_port_t *);
  jack_port_t *(*port_register)(jack_client_t *, const char *, const char *, unsigned long, unsigned long);
  int (*port_unregister)(jack_client_t *, jack_port_t *);
  int (*set_client_registration_callback)(jack_client_t *, JackClientRegistrationCallback, void *);
  int (*set_port_registration_callback)(jack_client_t *, JackPortRegistrationCallback, void *);
  int (*set_process_callback)(jack_client_t *, JackProcessCallback, void *);
  int (*set_xrun_callback)(jack_client_t *, JackXRunCallback, void *);
  int (*set_buffer_size_callback)(jack_client_t *, JackBufferSizeCallback, void *);
  int (*set_sample_rate_callback)(jack_client_t *, JackSampleRateCallback, void *);
  void (*set_error_function)(void (*)(const char *));
  void (*set_info_function)(void (*)(const char *));
} J;

static pthread_once_t loaded = PTHREAD_ONCE_INIT;

static void load(void) {
  void *lib = dlopen("libjack.so.0", RTLD_NOW | RTLD_LOCAL);
  if (lib == NULL) return;
#define TAKE(field, name) *(void **)(&J.field) = dlsym(lib, name)
  TAKE(client_open, "jack_client_open");
  TAKE(client_close, "jack_client_close");
  TAKE(activate, "jack_activate");
  TAKE(deactivate, "jack_deactivate");
  TAKE(connect, "jack_connect");
  TAKE(get_buffer_size, "jack_get_buffer_size");
  TAKE(get_sample_rate, "jack_get_sample_rate");
  TAKE(get_ports, "jack_get_ports");
  TAKE(on_shutdown, "jack_on_shutdown");
  TAKE(port_by_name, "jack_port_by_name");
  TAKE(port_get_buffer, "jack_port_get_buffer");
  TAKE(port_get_latency_range, "jack_port_get_latency_range");
  TAKE(port_name, "jack_port_name");
  TAKE(port_register, "jack_port_register");
  TAKE(port_unregister, "jack_port_unregister");
  TAKE(set_client_registration_callback, "jack_set_client_registration_callback");
  TAKE(set_port_registration_callback, "jack_set_port_registration_callback");
  TAKE(set_process_callback, "jack_set_process_callback");
  TAKE(set_xrun_callback, "jack_set_xrun_callback");
  TAKE(set_buffer_size_callback, "jack_set_buffer_size_callback");
  TAKE(set_sample_rate_callback, "jack_set_sample_rate_callback");
  TAKE(set_error_function, "jack_set_error_function");
  TAKE(set_info_function, "jack_set_info_function");
#undef TAKE
  /* Without the one that opens a client, none of the rest is reached. */
  if (J.client_open == NULL) J.client_close = NULL;
}

#define READY() pthread_once(&loaded, load)

jack_client_t *jack_client_open(const char *client_name, jack_options_t options, jack_status_t *status, ...) {
  READY();
  if (J.client_open == NULL || J.client_close == NULL) {
    if (status != NULL) *status = (jack_status_t)(JackFailure | JackServerFailed);
    return NULL;
  }
  /* The one optional argument there may be: a server's name. */
  if (options & JackServerName) {
    va_list ap;
    va_start(ap, status);
    const char *server = va_arg(ap, const char *);
    va_end(ap);
    return J.client_open(client_name, options, status, server);
  }
  return J.client_open(client_name, options, status);
}

/* The rest are only ever called with a client jack_client_open gave (or its
 * ports), so libjack is there; the checks cost nothing. */
#define PASS(ret, fail, field, params, args) \
  ret jack_##field params {                  \
    READY();                                 \
    if (J.field == NULL) return fail;        \
    return J.field args;                     \
  }
#define PASS_VOID(field, params, args) \
  void jack_##field params {           \
    READY();                           \
    if (J.field != NULL) J.field args; \
  }

PASS(int, -1, client_close, (jack_client_t *c), (c))
PASS(int, -1, activate, (jack_client_t *c), (c))
PASS(int, -1, deactivate, (jack_client_t *c), (c))
PASS(int, -1, connect, (jack_client_t *c, const char *from, const char *to), (c, from, to))
PASS(jack_nframes_t, 0, get_buffer_size, (jack_client_t *c), (c))
PASS(jack_nframes_t, 0, get_sample_rate, (jack_client_t *c), (c))
PASS(const char **, NULL, get_ports, (jack_client_t *c, const char *name, const char *type, unsigned long flags),
     (c, name, type, flags))
PASS(jack_port_t *, NULL, port_by_name, (jack_client_t *c, const char *name), (c, name))
PASS(void *, NULL, port_get_buffer, (jack_port_t *p, jack_nframes_t n), (p, n))
PASS(const char *, NULL, port_name, (const jack_port_t *p), (p))
PASS(jack_port_t *, NULL, port_register,
     (jack_client_t *c, const char *name, const char *type, unsigned long flags, unsigned long size),
     (c, name, type, flags, size))
PASS(int, -1, port_unregister, (jack_client_t *c, jack_port_t *p), (c, p))
PASS(int, -1, set_client_registration_callback, (jack_client_t *c, JackClientRegistrationCallback f, void *arg),
     (c, f, arg))
PASS(int, -1, set_port_registration_callback, (jack_client_t *c, JackPortRegistrationCallback f, void *arg),
     (c, f, arg))
PASS(int, -1, set_process_callback, (jack_client_t *c, JackProcessCallback f, void *arg), (c, f, arg))
PASS(int, -1, set_xrun_callback, (jack_client_t *c, JackXRunCallback f, void *arg), (c, f, arg))
PASS(int, -1, set_buffer_size_callback, (jack_client_t *c, JackBufferSizeCallback f, void *arg), (c, f, arg))
PASS(int, -1, set_sample_rate_callback, (jack_client_t *c, JackSampleRateCallback f, void *arg), (c, f, arg))
PASS_VOID(on_shutdown, (jack_client_t *c, JackShutdownCallback f, void *arg), (c, f, arg))
PASS_VOID(set_error_function, (void (*f)(const char *)), (f))
PASS_VOID(set_info_function, (void (*f)(const char *)), (f))

void jack_port_get_latency_range(jack_port_t *port, jack_latency_callback_mode_t mode, jack_latency_range_t *range) {
  READY();
  if (J.port_get_latency_range != NULL) {
    J.port_get_latency_range(port, mode, range);
  } else if (range != NULL) {
    range->min = range->max = 0;
  }
}
