// Which ASIO drivers the app may load (TODO 349). RtAudio loads every
// installed ASIO driver into the process just to list them, so one that
// crashes takes the app with it before anyone has chosen it. Here each driver
// is first tried in a process of its own — `asio-probe check "<name>"`,
// beside the app: that driver alone, opened, a second of silence, closed — and
// one that crashed or hung there is refused through RtAudio's driver filter
// (vendor/VENDOR-VERSIONS.md): never listed, never loaded. So are the drivers
// asiotiers.h knows to crash, untried.
//
// A driver is tried once per installed version: the verdict is kept in the
// settings with the driver's DLL path, size and date, and a driver whose DLL
// changed (updated, reinstalled) is tried again. A driver not yet tried is not
// loaded either: the checks run in the background from the start, and
// whatever is about to load ASIO waits for them (wait()). Without the helper
// (a build without it) nothing is refused but the known ones, as before.
//
// Windows only (MICROTONE_ASIO).
#pragma once

#include <QHash>
#include <QJsonArray>
#include <QObject>
#include <QString>

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>

#include "asiotiers.h"

namespace microtone::asio {

class AsioCheck {
 public:
  /** `finished` is called (from the checking thread) once a round of checks
   *  has ended and the verdicts have changed. */
  explicit AsioCheck(std::function<void()> finished);
  ~AsioCheck();

  /** Try, in the background, every installed driver not yet tried in its
   *  present version. Installs RtAudio's filter. */
  void start();
  /** Until the checks under way have ended, or `ms` has passed. → whether
   *  they have. */
  bool wait(int ms);
  bool checking() const { return running_.load(); }

  /** RtAudio's filter: may this driver be loaded? Any thread. */
  bool allows(const QString &name) const;

  /** For the Settings tab: the drivers left out, and why ("known", "crashed",
   *  "hung"). */
  QJsonArray refused() const;

 private:
  struct Entry {
    QString key;      // the DLL's path, size and date: a new version is tried again
    Verdict verdict = Verdict::Unchecked;
    QString detail;   // the exit code, for the log and the tab
  };
  void run(QList<QString> names);
  Entry tryOne(const QString &name, const QString &key);
  static QString settingsKey(const QString &name);

  std::function<void()> finished_;
  QString helper_;               // asio-probe.exe beside the app; empty: none
  mutable std::mutex mutex_;     // entries_
  QHash<QString, Entry> entries_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<bool> stopping_{false};   // the app is quitting: a check under way is ended
  std::mutex doneMutex_;
  std::condition_variable done_;
};

}  // namespace microtone::asio
