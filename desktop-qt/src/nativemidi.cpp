#include "nativemidi.h"

#include <algorithm>

#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QWebSocket>

#include "RtMidi.h"

namespace microtone {

namespace {

/** How often the port lists are read while a page is connected. */
constexpr int kPollMs = 1500;
/** The name the shell's own ports go by (ALSA lists them; aconnect shows them). */
constexpr char kClientName[] = "Microtone";

QJsonArray toArray(const QStringList &list) {
  QJsonArray a;
  for (const QString &s : list) a.append(s);
  return a;
}

QJsonValue nameOrNull(const QString &s) { return s.isEmpty() ? QJsonValue() : QJsonValue(s); }

}  // namespace

QString NativeMidi::plainName(const std::string &rtName) {
  QString name = QString::fromStdString(rtName);
  // RtMidi's ALSA backend ends every name with " <client>:<port>", and the
  // client number is handed out afresh when a device is plugged in again.
  static const QRegularExpression alsaNumbers(QStringLiteral(" \\d+:\\d+$"));
  name.remove(alsaNumbers);
  return name.trimmed();
}

NativeMidi::NativeMidi(QObject *parent) : QObject(parent) {
  poll_.setInterval(kPollMs);
  connect(&poll_, &QTimer::timeout, this, &NativeMidi::poll);
  flushTimer_.setSingleShot(true);
  connect(&flushTimer_, &QTimer::timeout, this, &NativeMidi::flushed);
}

void NativeMidi::whenFlushed(std::function<void()> done, int timeoutMs) {
  if (!socket_ || openOut_.isEmpty()) {
    done();
    return;
  }
  flushWaits_.push_back(std::move(done));
  flushTimer_.start(timeoutMs);
}

void NativeMidi::flushed() {
  flushTimer_.stop();
  // taken first: a wait may quit the app, or ask again
  std::vector<std::function<void()>> waits;
  waits.swap(flushWaits_);
  for (auto &done : waits) done();
}

NativeMidi::~NativeMidi() {
  poll_.stop();
  closeAll();  // joins RtMidi's input thread before anything it calls into goes
}

bool NativeMidi::ensureApis() {
  if (in_ && out_) return true;
  if (apisFailed_) return false;
  try {
    in_ = std::make_unique<RtMidiIn>(RtMidi::UNSPECIFIED, kClientName);
    out_ = std::make_unique<RtMidiOut>(RtMidi::UNSPECIFIED, kClientName);
    // The page's wish is the one rule for coming back: ALSA's own reconnect
    // would hold on to a port the list says has gone.
    in_->setAutoReconnect(false);
    out_->setAutoReconnect(false);
    // SysEx too (a surface's own answers); clocks and active sensing not.
    in_->ignoreTypes(false, true, true);
    in_->setCallback(&NativeMidi::onInput, this);
    return true;
  } catch (const RtMidiError &e) {
    error_ = QString::fromStdString(e.getMessage());
    qWarning("microtone: no MIDI (%s)", qUtf8Printable(error_));
    in_.reset();
    out_.reset();
    apisFailed_ = true;
    return false;
  }
}

void NativeMidi::attach(std::unique_ptr<QWebSocket> socket) {
  if (socket_) {
    socket_->disconnect(this);
    socket_->close();
    socket_.release()->deleteLater();
  }
  closeAll();
  wantIn_.clear();
  wantOut_.clear();
  wantKeyboards_.clear();
  socket_ = std::move(socket);
  QWebSocket *s = socket_.get();
  connect(s, &QWebSocket::textMessageReceived, this, &NativeMidi::onText);
  connect(s, &QWebSocket::binaryMessageReceived, this, &NativeMidi::onBinary);
  connect(s, &QWebSocket::disconnected, this, [this, s] {
    if (socket_.get() != s) return;
    poll_.stop();
    closeAll();
    wantIn_.clear();
    wantOut_.clear();
    wantKeyboards_.clear();
    socket_.release()->deleteLater();
    flushed();  // nothing more will come
  });
  ensureApis();
  readLists();
  poll_.start();
  sendState();
}

void NativeMidi::onText(const QString &text) {
  const QJsonObject msg = QJsonDocument::fromJson(text.toUtf8()).object();
  if (msg.contains(QStringLiteral("open"))) {
    const QJsonObject open = msg.value(QStringLiteral("open")).toObject();
    wantIn_ = open.value(QStringLiteral("input")).toString();
    wantOut_ = open.value(QStringLiteral("output")).toString();
    wantKeyboards_.clear();
    for (const QJsonValue &v : open.value(QStringLiteral("keyboards")).toArray()) {
      const QString name = v.toString();
      if (!name.isEmpty() && name != wantIn_ && !wantKeyboards_.contains(name)) wantKeyboards_.append(name);
    }
    error_.clear();
    readLists();
    reconcile();
    sendState();
  }
  // Text and binary messages keep their order on the socket, so every byte
  // the page sent before this has been handed to the port already.
  if (msg.value(QStringLiteral("flush")).toBool()) flushed();
}

void NativeMidi::onBinary(const QByteArray &bytes) {
  if (!out_ || openOut_.isEmpty() || bytes.isEmpty()) return;
  try {
    out_->sendMessage(reinterpret_cast<const unsigned char *>(bytes.constData()), size_t(bytes.size()));
  } catch (const RtMidiError &e) {
    error_ = QString::fromStdString(e.getMessage());
  }
}

void NativeMidi::poll() {
  const bool changed = readLists();
  const QString wasIn = openIn_, wasOut = openOut_;
  std::vector<int> wasKeyboards;
  for (const auto &k : keyboards_) wasKeyboards.push_back(k->id);
  reconcile();
  std::vector<int> nowKeyboards;
  for (const auto &k : keyboards_) nowKeyboards.push_back(k->id);
  if (changed || wasIn != openIn_ || wasOut != openOut_ || wasKeyboards != nowKeyboards) sendState();
}

/** The page's names for `api`'s ports, lined up with RtMidi's indices: the
 *  shell's own ports are blank (never offered, never matched). */
QStringList NativeMidi::pageNames(RtMidi &api) {
  QStringList names;
  for (unsigned i = 0, n = api.getPortCount(); i < n; i++) {
    const QString p = plainName(api.getPortName(i));
    names.append(p.startsWith(QLatin1String(kClientName) + u':') ? QString() : p);
  }
  QStringList out;
  for (const QString &n : names) {
    QString c = n;
    if (!n.isEmpty())
      for (int k = 2; out.contains(c); k++) c = n + QStringLiteral(" #") + QString::number(k);
    out.append(c);
  }
  return out;
}

bool NativeMidi::readLists() {
  if (!ensureApis()) return false;
  QStringList ins, outs;
  try {
    ins = pageNames(*in_);
    outs = pageNames(*out_);
  } catch (const RtMidiError &e) {
    error_ = QString::fromStdString(e.getMessage());
    return false;
  }
  ins.removeAll(QString());
  outs.removeAll(QString());
  const bool changed = ins != inputs_ || outs != outputs_;
  inputs_ = ins;
  outputs_ = outs;
  return changed;
}

/** Open what is wished for and listed; close what is open and is not. A
 *  port's index is found again from its name every time: indices move when
 *  devices come and go. */
void NativeMidi::reconcile() {
  if (!in_ || !out_) return;
  try {
    if (!openIn_.isEmpty() && (openIn_ != wantIn_ || !inputs_.contains(openIn_))) {
      in_->closePort();
      openIn_.clear();
    }
    if (openIn_.isEmpty() && !wantIn_.isEmpty()) {
      const qsizetype i = pageNames(*in_).indexOf(wantIn_);
      if (i >= 0) {
        in_->openPort(unsigned(i), std::string(kClientName) + " surface in");
        if (in_->isPortOpen()) openIn_ = wantIn_;
      }
    }
    if (!openOut_.isEmpty() && (openOut_ != wantOut_ || !outputs_.contains(openOut_))) {
      out_->closePort();
      openOut_.clear();
    }
    if (openOut_.isEmpty() && !wantOut_.isEmpty()) {
      const qsizetype i = pageNames(*out_).indexOf(wantOut_);
      if (i >= 0) {
        out_->openPort(unsigned(i), std::string(kClientName) + " surface out");
        if (out_->isPortOpen()) openOut_ = wantOut_;
      }
    }
  } catch (const RtMidiError &e) {
    error_ = QString::fromStdString(e.getMessage());
  }
  reconcileKeyboards();
}

/** The smallest id no open keyboard has, counting on from the last one given
 *  (so a message still on its way from a keyboard just closed is never taken
 *  for the next one's). 0 when all 127 are taken. */
int NativeMidi::freeKeyboardId() const {
  for (int n = 0; n < 127; n++) {
    const int id = (nextKeyboardId_ - 1 + n) % 127 + 1;
    if (!keyboardOpen(id)) return id;
  }
  return 0;
}

bool NativeMidi::keyboardOpen(int id) const {
  for (const auto &k : keyboards_)
    if (k->id == id) return true;
  return false;
}

/** The keyboards, as reconcile() does the surface: what is open and no longer wished
 *  for or listed is closed, and a wished-for one that is listed is opened —
 *  each on an RtMidiIn of its own (one port to an object). */
void NativeMidi::reconcileKeyboards() {
  if (!in_) return;
  for (auto it = keyboards_.begin(); it != keyboards_.end();) {
    if (!wantKeyboards_.contains((*it)->name) || !inputs_.contains((*it)->name)) it = keyboards_.erase(it);
    else ++it;
  }
  QStringList names;
  for (const QString &want : wantKeyboards_) {
    bool open = false;
    for (const auto &k : keyboards_) open = open || k->name == want;
    if (open || !inputs_.contains(want)) continue;
    if (names.isEmpty()) {
      try {
        names = pageNames(*in_);
      } catch (const RtMidiError &e) {
        error_ = QString::fromStdString(e.getMessage());
        return;
      }
    }
    const qsizetype i = names.indexOf(want);
    const int id = freeKeyboardId();
    if (i < 0 || id == 0) continue;
    auto k = std::make_unique<Keyboard>();
    k->name = want;
    k->id = id;
    k->self = this;
    try {
      k->in = std::make_unique<RtMidiIn>(RtMidi::UNSPECIFIED, kClientName);
      k->in->setAutoReconnect(false);
      // Notes, controllers and the rest; SysEx, clocks and active sensing not.
      k->in->ignoreTypes(true, true, true);
      k->in->setCallback(&NativeMidi::onKeyboard, k.get());
      k->in->openPort(unsigned(i), std::string(kClientName) + " keyboard in");
    } catch (const RtMidiError &e) {
      error_ = QString::fromStdString(e.getMessage());
      continue;
    }
    if (!k->in->isPortOpen()) continue;
    nextKeyboardId_ = id % 127 + 1;
    keyboards_.push_back(std::move(k));
  }
  // In the page's order, so the state reads as it asked.
  std::stable_sort(keyboards_.begin(), keyboards_.end(), [this](const auto &a, const auto &b) {
    return wantKeyboards_.indexOf(a->name) < wantKeyboards_.indexOf(b->name);
  });
}

void NativeMidi::closeAll() {
  try {
    if (in_ && in_->isPortOpen()) in_->closePort();
    if (out_ && out_->isPortOpen()) out_->closePort();
  } catch (const RtMidiError &) {
  }
  keyboards_.clear();  // each RtMidiIn closes its port and joins its thread
  openIn_.clear();
  openOut_.clear();
}

void NativeMidi::sendState() {
  if (!socket_) return;
  QJsonArray keyboards;
  for (const auto &k : keyboards_)
    keyboards.append(QJsonObject{{QStringLiteral("name"), k->name}, {QStringLiteral("id"), k->id}});
  QJsonObject msg{
      {QStringLiteral("ports"), QJsonObject{{QStringLiteral("inputs"), toArray(inputs_)},
                                            {QStringLiteral("outputs"), toArray(outputs_)}}},
      {QStringLiteral("open"), QJsonObject{{QStringLiteral("input"), nameOrNull(openIn_)},
                                           {QStringLiteral("output"), nameOrNull(openOut_)},
                                           {QStringLiteral("keyboards"), keyboards}}},
  };
  if (!error_.isEmpty()) msg.insert(QStringLiteral("error"), error_);
  socket_->sendTextMessage(QString::fromUtf8(QJsonDocument(msg).toJson(QJsonDocument::Compact)));
}

/** One message from source `source` (0 the surface, else a keyboard's id),
 *  as the page reads it: the source byte, then the message. On RtMidi's
 *  thread; the socket is the GUI thread's, so it is handed over, and dropped
 *  if the shell has gone by then (the context object) or the port has. */
void NativeMidi::forward(int source, const QByteArray &message) {
  QByteArray bytes;
  bytes.reserve(message.size() + 1);
  bytes.append(char(source));
  bytes.append(message);
  QMetaObject::invokeMethod(this, [this, source, bytes] {
    if (!socket_) return;
    if (source == 0 ? openIn_.isEmpty() : !keyboardOpen(source)) return;
    socket_->sendBinaryMessage(bytes);
  }, Qt::QueuedConnection);
}

void NativeMidi::onInput(double, std::vector<unsigned char> *message, void *user) {
  if (!message || message->empty()) return;
  static_cast<NativeMidi *>(user)->forward(
      0, QByteArray(reinterpret_cast<const char *>(message->data()), qsizetype(message->size())));
}

void NativeMidi::onKeyboard(double, std::vector<unsigned char> *message, void *user) {
  if (!message || message->empty()) return;
  // The Keyboard lives until its RtMidiIn has joined this thread, so it is
  // safe to read here; its id is all that crosses to the GUI thread.
  const auto *k = static_cast<const Keyboard *>(user);
  k->self->forward(k->id, QByteArray(reinterpret_cast<const char *>(message->data()), qsizetype(message->size())));
}

}  // namespace microtone
