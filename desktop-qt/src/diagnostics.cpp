#include "diagnostics.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QSysInfo>
#include <QThread>

#include <exception>
#include <mutex>

#include "crashlog.h"

namespace microtone {

namespace {

QFile *g_log = nullptr;
std::mutex g_mutex;
QtMessageHandler g_previous = nullptr;
QString g_dir;

void onMessage(QtMsgType type, const QMessageLogContext &context, const QString &text) {
  {
    const char *level = type == QtDebugMsg     ? "D"
                        : type == QtInfoMsg    ? "I"
                        : type == QtWarningMsg ? "W"
                        : type == QtCriticalMsg ? "C"
                                                : "F";
    const QByteArray line = QDateTime::currentDateTime().toString(QStringLiteral("HH:mm:ss.zzz")).toLatin1() + " [" +
                            QByteArray::number(quintptr(QThread::currentThreadId()), 16) + "] " + level + ": " +
                            text.toUtf8() + '\n';
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_log != nullptr) {
      g_log->write(line);
      g_log->flush();  // a crash must not take the last lines with it
    }
  }
  if (g_previous != nullptr) g_previous(type, context, text);
}

}  // namespace

QString installDiagnostics(const QString &dataDir) {
  g_dir = dataDir + QStringLiteral("/logs");
  QDir().mkpath(g_dir);
  const QString path = g_dir + QStringLiteral("/microtone.log");
  const QString previous = g_dir + QStringLiteral("/microtone.1.log");
  QFile::remove(previous);
  QFile::rename(path, previous);
  g_log = new QFile(path);
  if (!g_log->open(QIODevice::WriteOnly | QIODevice::Text)) {
    delete g_log;
    g_log = nullptr;
  }
  g_previous = qInstallMessageHandler(onMessage);

  mt_crashlog_install(QDir::toNativeSeparators(g_dir).toUtf8().constData(), MICROTONE_VERSION);
  std::set_terminate([] {
    mt_crashlog_report("std::terminate (an uncaught C++ exception)");
    std::abort();
  });

  // The windowing Qt chose (Linux: wayland or xcb) belongs in a report.
  qInfo("Microtone %s; Qt %s (%s); %s (%s, %s); started as: %s", MICROTONE_VERSION, qVersion(),
        qUtf8Printable(QGuiApplication::platformName()), qUtf8Printable(QSysInfo::prettyProductName()),
        qUtf8Printable(QSysInfo::kernelVersion()), qUtf8Printable(QSysInfo::currentCpuArchitecture()),
        qUtf8Printable(QCoreApplication::arguments().join(u' ')));
  return g_dir;
}

void reinstallCrashReporter() {
  if (!g_dir.isEmpty()) mt_crashlog_install(QDir::toNativeSeparators(g_dir).toUtf8().constData(), MICROTONE_VERSION);
}

}  // namespace microtone
