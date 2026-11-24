// Microtone desktop, Qt build: the web app in ../microtone-worker inside a
// QtWebEngine (Chromium) window. Chromium rather than the platform's webview
// because WebKitGTK delivers the audio port's blocks through the page's main
// thread — a bigger window, more painting, more dropouts — and hides
// SharedArrayBuffer (CLAUDE.TODOLIST.md item 336 has the measurements).
//
//   appserver   the loopback HTTP server the app is served from
//   shell       the profile, the windows, downloads, closing
//   links       where a link goes
//   nativeaudio the native audio host: the C engine (enginehost.c) on the
//               device's callback, driven by the page over a WebSocket
//
// Usage: microtone [--root <dir>] [--open <path?query>] [--web-audio]
//   --root  serve the web app from <dir> (default: the staged copy beside the
//           binary, else the working tree a dev build was configured from)
//   --open  the page to open instead of index.html, e.g.
//           "index.html?load=assets/demo_projects/Eighth.taud&autoplay&profile=1"
// Chromium's own switches (--remote-debugging-port=…) pass through, and so
// does QTWEBENGINE_CHROMIUM_FLAGS.

#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QIcon>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QMessageBox>
#include <QRandomGenerator>
#include <QStandardPaths>
#include <QWebSocket>

#include <vector>

#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

#include "appserver.h"
#include "diagnostics.h"
#include "filestore.h"
#include "online.h"
#include "updater.h"
#include "nativeaudio.h"
#include "shell.h"

using namespace microtone;

namespace {

/** The web app's root: --root, the staged copy beside the binary, or the
 *  working tree of a dev build. */
QString findRoot(const QString &override) {
  if (!override.isEmpty()) return QDir(override).absolutePath();
  const QString exe = QCoreApplication::applicationDirPath();
  for (const QString &candidate : {exe + QStringLiteral("/www"), exe + QStringLiteral("/../share/microtone/www"),
                                   exe + QStringLiteral("/../Resources/www")}) {
    if (QFileInfo::exists(candidate + QStringLiteral("/index.html"))) return QDir(candidate).absolutePath();
  }
#ifdef MICROTONE_DEV_ROOT
  if (QFileInfo::exists(QStringLiteral(MICROTONE_DEV_ROOT "/index.html"))) return QDir(QStringLiteral(MICROTONE_DEV_ROOT)).absolutePath();
#endif
  return {};
}

QByteArray newToken() {
  quint32 words[8];
  QRandomGenerator::system()->fillRange(words);
  return QByteArray(reinterpret_cast<const char *>(words), sizeof words).toHex();
}

/** Two instances would share one browser profile, projects and all: a second
 *  launch hands over to the first and leaves. */
QString instanceName() {
  return QStringLiteral("microtone-desktop-") + QString::fromLocal8Bit(qgetenv("USER").isEmpty() ? qgetenv("USERNAME") : qgetenv("USER"));
}

#ifdef Q_OS_LINUX
/** Does the system refuse the unprivileged user namespaces Chromium's
 *  sandbox is made of? Ubuntu (23.10 on) has AppArmor refuse them to a
 *  program without a profile of its own — an AppImage can bring none — and
 *  some kernels have them off. QtWebEngine's renderers would not start at
 *  all there: no page, a blank window. → why, or empty. */
QString userNamespacesRefused() {
  const auto read = [](const char *path) {
    QFile f(QString::fromLatin1(path));
    return f.open(QIODevice::ReadOnly) ? QString::fromLatin1(f.readAll()).trimmed() : QString();
  };
  if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") == u"1") {
    // Confined by a profile of its own, the program may have them.
    const QString label = read("/proc/self/attr/apparmor/current");
    if (label.isEmpty() || label == u"unconfined") return QStringLiteral("AppArmor restricts unprivileged user namespaces");
  }
  if (read("/proc/sys/kernel/unprivileged_userns_clone") == u"0") return QStringLiteral("unprivileged_userns_clone is 0");
  if (read("/proc/sys/user/max_user_namespaces") == u"0") return QStringLiteral("max_user_namespaces is 0");
  return {};
}

/** Can this copy of Qt load the platform theme `name`? A packaged copy
 *  (AppImage, .deb, .rpm: bin/ beside plugins/) loads only the theme plugins
 *  it carries and Qt's built-in ones; a build against the system's Qt loads
 *  whatever the system has. */
bool themeLoadable(const QByteArray &name) {
  const QDir themes(QFileInfo(QFile::symLinkTarget(QStringLiteral("/proc/self/exe"))).absolutePath() +
                    QStringLiteral("/../plugins/platformthemes"));
  if (!themes.exists()) return true;
  if (name == "kde" || name == "gnome" || name == "generic") return true;
  for (const QString &file : themes.entryList(QDir::Files))
    if (file.contains(QString::fromLocal8Bit(name), Qt::CaseInsensitive)) return true;
  return false;
}

/** The desktop's own file dialogs (KDE's, GNOME's, …) for Open and Save:
 *  `argv` with `-platformtheme xdgdesktopportal`, unless a theme this copy
 *  of Qt can load was chosen. Qt picks that theme by itself only inside
 *  Flatpak or Snap. Our packages carry Qt's own copy, so a desktop's own Qt
 *  theme plugin (Plasma's, which would have given KDE's dialogs) cannot
 *  load, and Qt's built-in KDE and GNOME themes have no native dialogs:
 *  Open and Save were Qt's generic one everywhere. Through the portal they
 *  are the desktop's wherever it has a FileChooser portal; where it has
 *  none, Qt's dialog as before. Everything else (palette, fonts, colour
 *  scheme) still comes from the theme Qt would have chosen, which the portal
 *  theme wraps. A QT_QPA_PLATFORMTHEME our Qt cannot load (qt5ct, qt6ct;
 *  "gtk2", which linuxdeploy's hook in the AppImage's start script sets on
 *  GNOME and XFCE and Qt 6 does not have) counts as no choice. An argument,
 *  never the variable: that would reach every program the app starts (the
 *  file manager behind Show folder, the browser), and those are the
 *  system's. */
std::vector<char *> withPortalTheme(int argc, char **argv) {
  static char themeSwitch[] = "-platformtheme", portal[] = "xdgdesktopportal";
  std::vector<char *> args(argv, argv + argc);
  const QByteArray named = qgetenv("QT_QPA_PLATFORMTHEME");
  bool chosen = !named.isEmpty() && themeLoadable(named);
  for (int i = 1; i < argc; ++i) chosen = chosen || !qstrcmp(argv[i], themeSwitch) || !qstrcmp(argv[i], "--platformtheme");
  if (!chosen && argc > 0) args.insert(args.begin() + 1, {themeSwitch, portal});
  args.push_back(nullptr);
  return args;
}
#endif

/** `flags` (QTWEBENGINE_CHROMIUM_FLAGS, split at spaces) with `feature` in
 *  its --enable-features, added to the one it has or as a switch of its own. */
QByteArray withFeatureEnabled(const QByteArray &flags, const QByteArray &feature) {
  static const QByteArray kSwitch = "--enable-features=";
  QList<QByteArray> words = flags.split(' ');
  for (auto it = words.rbegin(); it != words.rend(); ++it) {
    if (!it->startsWith(kSwitch)) continue;
    if (!it->mid(kSwitch.size()).split(',').contains(feature)) *it += (it->size() > kSwitch.size() ? "," : "") + feature;
    return words.join(' ');
  }
  return flags + ' ' + kSwitch + feature;
}

bool handOverToRunningInstance() {
  QLocalSocket socket;
  socket.connectToServer(instanceName());
  if (!socket.waitForConnected(500)) return false;
  socket.write("focus\n");
  socket.waitForBytesWritten(500);
  return true;
}

}  // namespace

int main(int argc, char **argv) {
#ifdef Q_OS_LINUX
  // Without the namespaces, Chromium's sandbox: the renderers run unsandboxed
  // rather than not at all. They only ever run this app's own pages (served
  // from its loopback server); anything else on the web opens in the
  // system's browser (links.cpp).
  const QString noSandbox = qEnvironmentVariableIsSet("QTWEBENGINE_DISABLE_SANDBOX") ? QString() : userNamespacesRefused();
  if (!noSandbox.isEmpty()) qputenv("QTWEBENGINE_DISABLE_SANDBOX", "1");
  std::vector<char *> args = withPortalTheme(argc, argv);
  int argCount = int(args.size()) - 1;  // QApplication keeps a reference: lives as long as `app`
  argv = args.data();
#else
  int &argCount = argc;
#endif
  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QApplication app(argCount, argv);
  // Both names: without an organisation QSettings reads and writes nothing
  // (the window's place, the audio output). Settings: <config>/Microtone/
  // Microtone.conf (Windows: HKCU\Software\Microtone\Microtone); the browser
  // profile — every project — below the app's LOCAL data folder (Windows:
  // %LOCALAPPDATA%\Microtone\Microtone, not the roaming one: projects are
  // big). The installer's uninstaller knows both (installer/microtone.nsi).
  QApplication::setOrganizationName(QStringLiteral("Microtone"));
  QApplication::setApplicationName(QStringLiteral("Microtone"));
  QApplication::setApplicationVersion(QStringLiteral(MICROTONE_VERSION));
  QGuiApplication::setDesktopFileName(QStringLiteral("cc.microtone.qt"));
#ifdef Q_OS_LINUX
  // The windows' icon. X11 reads it from the window; on Wayland the
  // compositor looks up the app id's desktop entry, which an AppImage has
  // not installed, so the icon goes with the window (xdg-toplevel-icon-v1:
  // KWin 6.1 on, Qt's xdg-shell plugin). GNOME has no such protocol; there
  // the entry an installed package (or an AppImage integrator) puts in
  // place is the only way.
  {
    QIcon icon;
    for (const char *size : {"32", "128", "256"}) icon.addFile(QStringLiteral(":/icons/microtone-%1.png").arg(QLatin1String(size)));
    QApplication::setWindowIcon(icon);
  }
#endif

  QCommandLineParser cli;
  cli.setApplicationDescription(QStringLiteral("Microtone"));
  cli.addHelpOption();
  cli.addVersionOption();
  QCommandLineOption rootOption(QStringLiteral("root"), QStringLiteral("Serve the web app from <dir>."), QStringLiteral("dir"));
  QCommandLineOption openOption(QStringLiteral("open"), QStringLiteral("Open <page> instead of index.html."), QStringLiteral("page"));
  QCommandLineOption webAudioOption(QStringLiteral("web-audio"),
                                    QStringLiteral("Play through the page's own Web Audio, not the native host."));
  cli.addOptions({rootOption, openOption, webAudioOption});
  cli.parse(QCoreApplication::arguments());  // not process(): Chromium's switches are not ours
  if (cli.isSet(QStringLiteral("help"))) cli.showHelp();
  if (cli.isSet(QStringLiteral("version"))) cli.showVersion();

  if (handOverToRunningInstance()) return 0;

  // The log and the crash reporter first: everything after may need them.
  // (After the hand-over: a second launch must not rotate the first's log.)
  const QString dataDir = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
  QDir().mkpath(dataDir);
  installDiagnostics(dataDir);
#ifdef Q_OS_LINUX
  if (!noSandbox.isEmpty()) qInfo("microtone: the page runs without Chromium's sandbox (%s)", qUtf8Printable(noSandbox));
#endif
#ifdef Q_OS_WIN
  // Held for the app's life (Windows lets it go at exit): the installer asks
  // by this name whether the app is running before it replaces or removes it.
  CreateMutexW(nullptr, FALSE, L"Local\\microtone-desktop");
#endif

  const QString root = findRoot(cli.value(rootOption));
  if (root.isEmpty()) {
    QMessageBox::critical(nullptr, QStringLiteral("Microtone"), QStringLiteral("The app's files were not found."));
    return 1;
  }

  const QByteArray token = newToken();
  AppServer server(root, token);
  // The projects, soundfonts and keymaps: ordinary files in ~/Microtone.
  FileStore files(dataDir);
  server.setFileStore(&files);
  // What the earlier desktop app kept comes over too, in the background.
  files.startOldAppCopy();
  // Online projects, through the site with the app's own token.
  Online online(dataDir);
  server.setOnline(&online);
  // Updates: checked from the page, installed when the app quits.
  Updater updater(dataDir);
  if (!server.start()) {
    QMessageBox::critical(nullptr, QStringLiteral("Microtone"), QStringLiteral("Microtone could not start its local server."));
    return 1;
  }

  // The origin has no port (see appserver.h); Chromium sends its name to the
  // port the server got. Read when the first profile starts the engine, so it
  // must be set before the Shell exists.
  QByteArray flags = qgetenv("QTWEBENGINE_CHROMIUM_FLAGS");
  flags += " --host-resolver-rules=\"MAP " + QByteArray(kAppHost) + " 127.0.0.1:" + QByteArray::number(server.port()) + '"';
  // Scrollbars that float over the content and fade when it stops, in the
  // page's own `scrollbar-color` (microtone.css): Chromium's Fluent overlay
  // scrollbars, Windows and Linux (macOS draws its own, overlay by system
  // setting). Plain `OverlayScrollbar` does nothing on either. Joined to an
  // --enable-features already in the variable: Chromium keeps only the last.
  flags = withFeatureEnabled(flags, "FluentOverlayScrollbar");
  // …and the same scrollbar on EVERY scroller. Only a composited scroller
  // gets the compositor's one (lingers, thickens under the pointer); one
  // Chromium paints itself stays thin and fades at once. Chromium declines
  // to composite a scroller whose ground is not opaque, or that it cannot
  // prove opaque, to keep subpixel text — a textarea, a list in a dialog,
  // the Motif editor (transparent over its highlighting) — so the Samples
  // list had the one and the notation maker's degrees the other. This
  // composites them all; their text is then greyscale-antialiased.
  if (!flags.contains("--enable-prefer-compositing-to-lcd-text")) flags += " --enable-prefer-compositing-to-lcd-text";
  qputenv("QTWEBENGINE_CHROMIUM_FLAGS", flags.trimmed());

  // The native audio host: the engine on the device's own callback. Without
  // a device (or with --web-audio) the page plays through Web Audio as in a
  // browser, and the socket refuses.
  NativeAudio native;
  QString nativeEngine;
  if (!cli.isSet(webAudioOption)) {
    QString why;
    if (native.start(&why)) {
      server.setEngineSockets([&native](std::unique_ptr<QWebSocket> socket) { native.attach(std::move(socket)); });
      nativeEngine = QStringLiteral("ws://") + QLatin1String(kAppHost) + QStringLiteral("/engine?t=") +
                     QString::fromLatin1(token);
    } else {
      qWarning("microtone: no native audio (%s); the page plays through Web Audio", qUtf8Printable(why));
    }
  }

  Shell shell(QUrl(QStringLiteral("http://") + QLatin1String(kAppHost) + u'/'), token, dataDir, nativeEngine,
              nativeEngine.isEmpty() ? QJsonObject() : native.status(),
              QJsonObject{{QStringLiteral("files"), files.describe()},
                          {QStringLiteral("online"), online.describe()},
                          {QStringLiteral("updates"), updater.describe()},
                          // storage/import-export.js: a picker's title, said before it opens
                          {QStringLiteral("dialogs"), QJsonObject{{QStringLiteral("base"), QStringLiteral("/api/desktop/dialog")}}}});
  QObject::connect(&online, &Online::authChanged, &shell, &Shell::onlineAuth);
  server.setUpdater(&updater, [&shell] { shell.quit(); });
  server.setDialogs([&shell](const QString &kind, const QString &title, const QString &lang) {
    shell.announceDialog(kind, title, lang);
  });

  // Chromium is up now, and may have put its own crash filter first.
  reinstallCrashReporter();

  QLocalServer instances;
  QLocalServer::removeServer(instanceName());  // a crashed run's socket
  if (instances.listen(instanceName())) {
    QObject::connect(&instances, &QLocalServer::newConnection, &shell, [&] {
      while (QLocalSocket *peer = instances.nextPendingConnection()) {
        peer->deleteLater();
        shell.focusMain();
      }
    });
  }

  QString page = cli.value(openOption);
  if (page.startsWith(u'/')) page.remove(0, 1);
  shell.openMain(shell.origin().resolved(QUrl(page.isEmpty() ? QStringLiteral("index.html") : page)));
  const int code = app.exec();
  // An update asked for: the installer (or the new bundle) takes over once
  // this process is gone. Nobody is to find this one still listening.
  instances.close();
  updater.installNow();
  return code;
}
