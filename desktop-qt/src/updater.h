// Updates. The app asks https://microtone.cc/api/desktop/update (the site
// redirects to the channel's manifest on GitHub: server/desktop-update.js),
// which has the Tauri updater's latest.json shape —
//
//   { "version", "notes", "pub_date",
//     "platforms": { "windows-x86_64": { "url", "signature" },
//                    "darwin-universal" | "darwin-aarch64" | "darwin-x86_64": … } }
//
// — so at the switch one release can move the Tauri copies over and update
// these. Nothing is downloaded until the person says so (the page's banner,
// src/ui/desktopupdates.js); a download is checked against the updater key
// (minisign.h, updatekey.h) before anything is done with it; and it is
// installed only when the app quits — "Restart now" quits it — so an update
// never takes the window from someone in the middle of a song:
//
//   Windows   the downloaded installer, run with /P (and /R to start the app
//             again); it waits for this process to be gone (its mutex)
//   macOS     the downloaded Microtone.app.tar.gz, unpacked beforehand; at
//             quit the running bundle steps aside, the new one takes its
//             place, and a small helper waits for this process to end before
//             removing the old one (and starting the new, when asked)
//   Linux     nothing yet: no packaged build to replace (updatable() false)
//
// Only an installed copy updates: on Windows one the installer put where it
// says (its InstallLocation), on macOS an .app in a folder it may write — not
// a disk image, not a translocated copy, not a build tree.
//
// The page talks to it over the app's server (appserver.cpp):
//   GET  /api/desktop/updates                {state, current, version, notes, progress, error, updatable, channel}
//   POST /api/desktop/updates?check | ?download | ?install=quit | ?install=now
// state: idle, checking, none, available, downloading, ready, error.
//
// MICROTONE_UPDATE_URL=<manifest url> and MICROTONE_UPDATE_KEY=<public key>
// (tests: a local manifest, a key of their own); MICROTONE_UPDATE_TEST=run
// makes any copy updatable, the download a program run at quit as the
// Windows installer is (with /P, /R).
#pragma once

#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QPointer>
#include <QString>

class QFile;
class QNetworkReply;

namespace microtone {

class Updater : public QObject {
  Q_OBJECT
 public:
  explicit Updater(const QString &dataDir, QObject *parent = nullptr);

  /** Can this copy replace itself? */
  bool updatable() const { return updatable_; }
  /** For the page (window.__MICROTONE_NATIVE__.updates). */
  QJsonObject describe() const;
  QJsonObject status() const;

  void check();
  void download();
  /** Install when the app quits; `restart`: start it again then. */
  void installOnQuit(bool restart);
  bool installPending() const { return installOnQuit_; }
  /** After the event loop: hand over to the installer, or put the new
   *  bundle in place. Does nothing unless installOnQuit() was asked. */
  void installNow();

  /** Is version `a` newer than `b`? (x.y.z, a -pre release before its
   *  release.) */
  static bool newer(const QString &a, const QString &b);
  /** The manifest's entry for this machine, in order of preference. */
  static QStringList platformKeys();

 signals:
  void changed();

 private:
  void setState(const QString &state, const QString &error = {});
  void verifyAndPrepare();

  QString dir_;        // <app data>/update
  QString manifest_;   // where to ask
  QString channel_;
  bool updatable_ = false;
  bool testRun_ = false;

  QString state_ = QStringLiteral("idle");
  QString error_;
  QString version_, notes_, url_;
  QByteArray signature_;
  double progress_ = 0;
  QString file_;       // the verified download
  QString prepared_;   // macOS: the unpacked Microtone.app
  bool installOnQuit_ = false;
  bool restart_ = false;

  QNetworkAccessManager net_;
  QPointer<QNetworkReply> reply_;
  QFile *out_ = nullptr;
};

}  // namespace microtone
