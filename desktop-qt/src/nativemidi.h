// The control surface's MIDI ports (item 379), for the page.
//
// QtWebEngine has Web MIDI compiled in and refuses every request: it has no
// MIDI permission to grant (QWebEnginePermission has no such type; measured
// on 6.11.1, with Chromium's BlockMidiByDefault switched off as well). So the
// shell opens one input and one output itself, with RtMidi, and the page
// reaches them over a WebSocket of its own beside the engine's:
//
//   page → shell  text    {"open": {"input": name|null, "output": name|null}}
//                 binary  one whole MIDI message, for the open output
//   shell → page  text    {"ports": {"inputs": [...], "outputs": [...]},
//                          "open": {"input", "output"}, "error"?}
//                 binary  one whole MIDI message from the open input
//
// The page's side is microtone-worker/src/midi/ports.js.
//
// Ports are known by NAME, as the page remembers them: the system's name
// without what RtMidi adds to it — ALSA's "client:port" numbers, which a
// replug changes — and with " #2", " #3" on names that would otherwise be
// the same. What the page asked for is kept as a wish: the list is read again
// every 1.5 s while a page is connected, and a wished-for port that turns up
// is opened, one that goes is closed.
//
// Threads: RtMidi calls back on its own thread; a message is handed to the
// GUI thread, which owns the socket and the ports.
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QTimer>

#include <functional>
#include <memory>
#include <string>
#include <vector>

class QWebSocket;
// RtMidi.h (6.x) declares its classes in rt::midi.
namespace rt::midi {
class RtMidi;
class RtMidiIn;
class RtMidiOut;
}  // namespace rt::midi

namespace microtone {

class NativeMidi : public QObject {
  Q_OBJECT
 public:
  explicit NativeMidi(QObject *parent = nullptr);
  ~NativeMidi() override;

  /** The page's connection; a new one (a reload) replaces the old, and a
   *  page that goes lets its ports go. */
  void attach(std::unique_ptr<QWebSocket> socket);

  /** A port name as the page sees it: RtMidi's, without ALSA's trailing
   *  "client:port" numbers. */
  static QString plainName(const std::string &rtName);

  /** Call `done` once everything the page has sent so far has gone to the
   *  device: when the page's `{"flush": true}` arrives (ports.js `flush()`,
   *  sent after the surface's goodbye), when the page goes, or after
   *  `timeoutMs`. At once when no output is open, since then nothing is on
   *  its way. One wait at a time; a second replaces the first's timer and
   *  calls it as well. */
  void whenFlushed(std::function<void()> done, int timeoutMs);

 private:
  bool ensureApis();
  void onText(const QString &text);
  void onBinary(const QByteArray &bytes);
  void poll();
  static QStringList pageNames(rt::midi::RtMidi &api);
  bool readLists();
  void reconcile();
  void closeAll();
  void sendState();
  void flushed();
  static void onInput(double stamp, std::vector<unsigned char> *message, void *user);

  std::unique_ptr<rt::midi::RtMidiIn> in_;
  std::unique_ptr<rt::midi::RtMidiOut> out_;
  std::unique_ptr<QWebSocket> socket_;
  QTimer poll_;
  QStringList inputs_, outputs_;   // as the page sees them
  QString wantIn_, wantOut_;       // what the page asked for
  QString openIn_, openOut_;       // what is open
  QString error_;
  bool apisFailed_ = false;
  std::vector<std::function<void()>> flushWaits_;
  QTimer flushTimer_;
};

}  // namespace microtone
