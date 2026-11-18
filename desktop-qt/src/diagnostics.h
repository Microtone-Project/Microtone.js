// What the app leaves behind for whoever has to find out why it misbehaved on
// a machine they cannot sit at: in <app data>/logs,
//
//   microtone.log     this run's messages (qInfo/qWarning…), each with the
//                     time and the thread; microtone.1.log is the run before
//   crash-*.txt/.dmp  a crash report (crashlog.h), if the run died
//
// The audio host logs every output it opens or fails to open, so a log plus a
// crash report is a full account of a failure. The Windows installer's
// "Microtone diagnostics" collects them (installer/diagnostics.cmd).
#pragma once

#include <QString>

namespace microtone {

/** Start logging into <dataDir>/logs and install the crash reporter; returns
 *  the folder. Call once, early. */
QString installDiagnostics(const QString &dataDir);

/** Again, once the browser engine is up: it may have put its own crash
 *  filter in front of ours. */
void reinstallCrashReporter();

}  // namespace microtone
