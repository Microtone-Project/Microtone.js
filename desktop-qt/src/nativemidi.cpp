#include "nativemidi.h"

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
  reconcile();
  if (changed || wasIn != openIn_ || wasOut != openOut_) sendState();
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
}

void NativeMidi::closeAll() {
  try {
    if (in_ && in_->isPortOpen()) in_->closePort();
    if (out_ && out_->isPortOpen()) out_->closePort();
  } catch (const RtMidiError &) {
  }
  openIn_.clear();
  openOut_.clear();
}

void NativeMidi::sendState() {
  if (!socket_) return;
  QJsonObject msg{
      {QStringLiteral("ports"), QJsonObject{{QStringLiteral("inputs"), toArray(inputs_)},
                                            {QStringLiteral("outputs"), toArray(outputs_)}}},
      {QStringLiteral("open"), QJsonObject{{QStringLiteral("input"), nameOrNull(openIn_)},
                                           {QStringLiteral("output"), nameOrNull(openOut_)}}},
  };
  if (!error_.isEmpty()) msg.insert(QStringLiteral("error"), error_);
  socket_->sendTextMessage(QString::fromUtf8(QJsonDocument(msg).toJson(QJsonDocument::Compact)));
}

void NativeMidi::onInput(double, std::vector<unsigned char> *message, void *user) {
  auto *self = static_cast<NativeMidi *>(user);
  if (!message || message->empty()) return;
  const QByteArray bytes(reinterpret_cast<const char *>(message->data()), qsizetype(message->size()));
  // RtMidi's thread: the socket is the GUI thread's. Dropped if the shell has
  // gone by then (the context object).
  QMetaObject::invokeMethod(self, [self, bytes] {
    if (self->socket_ && !self->openIn_.isEmpty()) self->socket_->sendBinaryMessage(bytes);
  }, Qt::QueuedConnection);
}

}  // namespace microtone
