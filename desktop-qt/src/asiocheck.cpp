#include "asiocheck.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QJsonObject>
#include <QProcess>
#include <QSettings>

#include <algorithm>
#include <chrono>

#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>  // all of it: asiolist.h wants COM's CLSID

#include "asiolist.h"
#endif
// Elsewhere only for its test (no ASIO there): the drivers and the helper
// come from MICROTONE_ASIO_TEST_DRIVERS ("name=dll;…") and
// MICROTONE_ASIO_TEST_PROBE.

// RtAudio's ASIO driver filter (its patch 1: vendor/VENDOR-VERSIONS.md).
extern bool (*rtaudio_asio_driver_allowed)(const char *name);

namespace microtone::asio {

namespace {

AsioCheck *g_check = nullptr;
std::atomic<bool> g_helperFailed{false};  // asio-probe would not start: nothing can be tried

/** The filter RtAudio calls before it loads a driver (in its listing). */
bool allowedByCheck(const char *name) {
  return g_check == nullptr || g_check->allows(QString::fromLocal8Bit(name));
}

struct Installed {
  QString name;
  QString key;
};

/** A driver's version, as far as the app can tell: its DLL's path, size and
 *  date. */
QString versionKey(const QString &dllPath) {
  const QFileInfo dll(dllPath);
  return QStringLiteral("%1|%2|%3").arg(dll.absoluteFilePath()).arg(dll.size()).arg(dll.lastModified().toMSecsSinceEpoch());
}

/** The installed drivers, from the registry as the SDK reads it (nothing is
 *  loaded), named as RtAudio names them: at most 31 characters. */
QList<Installed> installedDrivers() {
  QList<Installed> out;
#ifdef Q_OS_WIN
  AsioDriverList list;
  for (int i = 0; i < int(list.asioGetNumDev()); i++) {
    char name[32] = {};
    char path[MAXPATHLEN] = {};
    if (list.asioGetDriverName(i, name, int(sizeof name)) != 0) continue;
    list.asioGetDriverPath(i, path, int(sizeof path));
    out.append({QString::fromLocal8Bit(name), versionKey(QString::fromLocal8Bit(path))});
  }
#else
  for (const QString &d : qEnvironmentVariable("MICROTONE_ASIO_TEST_DRIVERS").split(u';', Qt::SkipEmptyParts)) {
    const QStringList nameDll = d.split(u'=');
    out.append({nameDll.value(0), versionKey(nameDll.value(1))});
  }
#endif
  return out;
}

QString helperPath() {
#ifdef Q_OS_WIN
  return QCoreApplication::applicationDirPath() + QStringLiteral("/asio-probe.exe");
#else
  return qEnvironmentVariable("MICROTONE_ASIO_TEST_PROBE");
#endif
}

}  // namespace

AsioCheck::AsioCheck(std::function<void()> finished) : finished_(std::move(finished)) {}

AsioCheck::~AsioCheck() {
  // A check under way is ended by its own thread within a tenth of a second
  // (tryOne), not waited for: the app is quitting, and an unfinished check
  // is simply not recorded.
  stopping_ = true;
  if (thread_.joinable()) thread_.join();
  if (g_check == this) {
    rtaudio_asio_driver_allowed = nullptr;
    g_check = nullptr;
  }
}

QString AsioCheck::settingsKey(const QString &name) {
  // A driver's name may hold a slash, which QSettings would read as a group.
  return QStringLiteral("asio/check/") + QString::fromLatin1(name.toUtf8().toHex());
}

void AsioCheck::start() {
  g_check = this;
  rtaudio_asio_driver_allowed = &allowedByCheck;
  const QString helper = helperPath();
  helper_ = !helper.isEmpty() && QFileInfo::exists(helper) ? helper : QString();

  QSettings settings;
  QList<QString> pending;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const Installed &d : installedDrivers()) {
      Entry e;
      e.key = d.key;
      if (tierOf(d.name.toStdString()) != Tier::Blocked) {  // a known one is never tried
        const QStringList stored = settings.value(settingsKey(d.name)).toStringList();  // name, key, verdict, detail
        if (stored.size() >= 3 && stored.at(1) == d.key) {
          e.verdict = verdictNamed(stored.at(2).toStdString());
          e.detail = stored.value(3);
        }
        if (e.verdict == Verdict::Unchecked) pending << d.name;
      }
      entries_.insert(d.name, e);
    }
  }
  if (helper_.isEmpty()) {
    qWarning("audio: asio-probe.exe is not beside the app: ASIO drivers are loaded untried");
    return;
  }
  for (auto it = entries_.cbegin(); it != entries_.cend(); ++it) {
    if (it->verdict != Verdict::Unchecked)
      qInfo("audio: ASIO driver \"%s\": %s when tried (%s)", qUtf8Printable(it.key()), verdictName(it->verdict),
            qUtf8Printable(it->detail));
  }
  if (pending.isEmpty()) return;
  qInfo("audio: trying %lld ASIO driver(s) in a process of their own before any is loaded",
        static_cast<long long>(pending.size()));
  running_ = true;
  thread_ = std::thread([this, pending] { run(pending); });
}

bool AsioCheck::wait(int ms) {
  std::unique_lock<std::mutex> lock(doneMutex_);
  return done_.wait_for(lock, std::chrono::milliseconds(ms), [this] { return !running_.load(); });
}

void AsioCheck::run(QList<QString> names) {
  bool changed = false;
  for (const QString &name : names) {
    if (stopping_) break;
    QString key;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      key = entries_.value(name).key;
    }
    const Entry e = tryOne(name, key);
    if (stopping_ || e.verdict == Verdict::Unchecked) break;  // quitting, or the helper would not start
    {
      std::lock_guard<std::mutex> lock(mutex_);
      entries_.insert(name, e);
    }
    QSettings().setValue(settingsKey(name),
                         QStringList{name, e.key, QString::fromLatin1(verdictName(e.verdict)), e.detail});
    changed = true;
  }
  {
    std::lock_guard<std::mutex> lock(doneMutex_);
    running_ = false;
  }
  done_.notify_all();
  if (changed && !stopping_ && finished_) finished_();
}

AsioCheck::Entry AsioCheck::tryOne(const QString &name, const QString &key) {
  Entry e;
  e.key = key;
  QProcess p;
  p.setProgram(helper_);
  p.setArguments({QStringLiteral("check"), name});
  p.setProcessChannelMode(QProcess::MergedChannels);
#ifdef Q_OS_WIN
  // A console program, started from a window: no console of its own.
  p.setCreateProcessArgumentsModifier([](QProcess::CreateProcessArguments *a) { a->flags |= CREATE_NO_WINDOW; });
#endif
  p.start();
  if (!p.waitForStarted(5000)) {
    g_helperFailed = true;
    qWarning("audio: asio-probe.exe would not start (%s): ASIO drivers are loaded untried",
             qUtf8Printable(p.errorString()));
    return e;  // Unchecked
  }
  // A tenth of a second at a time, so a quitting app is not kept waiting.
  QElapsedTimer clock;
  clock.start();
  while (p.state() != QProcess::NotRunning && clock.elapsed() < 15000) {
    p.waitForFinished(100);
    if (stopping_) {
      p.kill();
      p.waitForFinished(3000);
      return Entry{key, Verdict::Unchecked, {}};
    }
  }
  const bool finished = p.state() == QProcess::NotRunning;
  if (!finished) {
    p.kill();
    p.waitForFinished(3000);
  }
  const unsigned long code = static_cast<unsigned long>(static_cast<unsigned int>(p.exitCode()));
  e.verdict = verdictOf(code, finished && p.exitStatus() == QProcess::CrashExit, !finished);
  e.detail = finished ? QStringLiteral("exit 0x%1").arg(code, 8, 16, QLatin1Char('0'))
                      : QStringLiteral("no answer in 15 s");
  const QList<QByteArray> said = p.readAll().trimmed().split('\n');
  qInfo("audio: ASIO driver \"%s\" tried in a process of its own: %s (%s; it said: %s)%s", qUtf8Printable(name),
        verdictName(e.verdict), qUtf8Printable(e.detail), said.isEmpty() ? "" : said.last().trimmed().constData(),
        refuses(e.verdict) ? " — it will not be loaded" : "");
  return e;
}

bool AsioCheck::allows(const QString &name) const {
  if (tierOf(name.toStdString()) == Tier::Blocked) return false;
  const bool untriedOk = helper_.isEmpty() || g_helperFailed.load();
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = entries_.constFind(name);
  if (it == entries_.cend() || it->verdict == Verdict::Unchecked) return untriedOk;
  return !refuses(it->verdict);
}

QJsonArray AsioCheck::refused() const {
  std::lock_guard<std::mutex> lock(mutex_);
  QList<QString> names = entries_.keys();
  std::sort(names.begin(), names.end());
  QJsonArray out;
  for (const QString &name : names) {
    const Entry &e = entries_[name];
    const char *why = tierOf(name.toStdString()) == Tier::Blocked ? "known" : refuses(e.verdict) ? verdictName(e.verdict) : nullptr;
    if (why) out.append(QJsonObject{{QStringLiteral("name"), name}, {QStringLiteral("why"), QString::fromLatin1(why)}});
  }
  return out;
}

}  // namespace microtone::asio
