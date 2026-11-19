// The system's word on audio devices, on Linux, where no one API speaks for
// all of them as Core Audio's property listeners do on macOS and
// IMMNotificationClient on Windows (nativeaudio.cpp, wasapi.c):
//
//   PulseAudio  (which PipeWire answers) a subscription to its sinks and its
//               server: a sink added or removed, the default sink changed,
//               the server gone or back
//   ALSA        /dev/snd: a card added or removed
//   JACK        while JACK is the open output, a client of our own with no
//               ports, told of clients and ports coming and going, of the
//               server's buffer size or rate changing (RtAudio's stream
//               cannot follow either: it is opened again), and of the server
//               shutting down; and, while the person's chosen output is JACK
//               but JACK is not running, a look every two seconds for the
//               server coming up
//
// Each tells its owner through the hooks, from a thread of its own (the
// PulseAudio main loop's, JACK's notification thread) or the GUI thread's
// (ALSA, the JACK look): a hook only notes it, and the owner's pump does the
// rest.
#pragma once

#include <QObject>
#include <QTimer>

#include <functional>
#include <memory>
#include <string>

class QFileSystemWatcher;

namespace microtone {

class LinuxAudioWatch : public QObject {
  Q_OBJECT
 public:
  struct Hooks {
    std::function<void()> devices;        // the list of devices changed
    std::function<void()> defaultOutput;  // the default output changed (PulseAudio)
    std::function<void()> lost;           // the open JACK stream must be opened again
  };

  explicit LinuxAudioWatch(Hooks hooks, QObject *parent = nullptr);
  ~LinuxAudioWatch() override;

  /** JACK is open, connected to `device` (a JACK client: RtAudio's device
   *  name), at the server's `rate` and `frames`. */
  void watchJack(const std::string &device, unsigned rate, unsigned frames);
  /** Before the JACK stream is closed. */
  void unwatchJack();
  /** Look for a JACK server every two seconds (`on`), telling `devices`
   *  when one comes up. */
  void lookForJack(bool on);

 private:
  struct Pulse;
  struct Jack;
  Hooks hooks_;
  std::unique_ptr<Pulse> pulse_;
  std::unique_ptr<Jack> jack_;
  QFileSystemWatcher *snd_ = nullptr;
  QTimer jackLook_;
  bool jackWasUp_ = false;
};

}  // namespace microtone
