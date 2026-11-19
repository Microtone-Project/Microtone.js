#include "updater.h"

#include <QCoreApplication>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRegularExpression>
#include <QSettings>
#include <QStandardPaths>
#include <QSysInfo>
#include <QUrl>
#include <QUrlQuery>

#include <cstdio>

#include "minisign.h"
#include "updatekey.h"

#ifndef MICROTONE_UPDATE_CHANNEL
#define MICROTONE_UPDATE_CHANNEL "stable"
#endif

namespace microtone {

namespace {

constexpr char kSite[] = "https://microtone.cc/api/desktop/update";
const QString kCurrent = QStringLiteral(MICROTONE_VERSION);

/** Where a person downloads a release, when the manifest does not say. */
QString defaultPage(const QString &channel) {
  const QString releases = QStringLiteral("https://github.com/Microtone-Project/Microtone.js/releases");
  return channel == u"preview" ? releases + QStringLiteral("/tag/desktop-preview") : releases + QStringLiteral("/latest");
}

#if defined(Q_OS_LINUX)
/** The running AppImage's file, when this is one: the runtime says so in
 *  APPIMAGE, and this binary is inside its mount (APPDIR) — not a program
 *  started from inside one. */
QString runningAppImage() {
  const QString file = qEnvironmentVariable("APPIMAGE"), mount = qEnvironmentVariable("APPDIR");
  if (file.isEmpty() || mount.isEmpty()) return {};
  const QString dir = QFileInfo(QCoreApplication::applicationDirPath()).canonicalFilePath();
  const QString root = QFileInfo(mount).canonicalFilePath();
  if (root.isEmpty() || !(dir == root || dir.startsWith(root + u'/'))) return {};
  return QFileInfo(file).absoluteFilePath();
}

/** A package's mark of its kind (tools/linux-package.sh): "deb" or "rpm". */
QString packageKind() {
  QFile mark(QCoreApplication::applicationDirPath() + QStringLiteral("/../share/microtone/package"));
  if (!mark.open(QIODevice::ReadOnly)) return {};
  const QString kind = QString::fromUtf8(mark.readAll()).trimmed();
  return kind == u"deb" || kind == u"rpm" ? kind : QString();
}
#endif

#if defined(Q_OS_MACOS)
/** The running .app, or empty. */
QString runningBundle() {
  const QString bundle = QDir(QCoreApplication::applicationDirPath() + QStringLiteral("/../..")).canonicalPath();
  return bundle.endsWith(QStringLiteral(".app")) ? bundle : QString();
}
#endif

QString platformName() {
#if defined(Q_OS_WIN)
  return QStringLiteral("windows-x86_64");
#elif defined(Q_OS_MACOS)
  return QStringLiteral("darwin-universal");
#else
  return QStringLiteral("linux-x86_64");
#endif
}

}  // namespace

Updater::Updater(const QString &dataDir, QObject *parent) : QObject(parent) {
  dir_ = dataDir + QStringLiteral("/update");
  // Whatever an earlier run downloaded has been installed, or was not wanted.
  QDir(dir_).removeRecursively();
  channel_ = QStringLiteral(MICROTONE_UPDATE_CHANNEL);
  page_ = defaultPage(channel_);
  testRun_ = qEnvironmentVariable("MICROTONE_UPDATE_TEST") == u"run";
  testSudo_ = qEnvironmentVariable("MICROTONE_UPDATE_TEST") == u"sudo";
  manifest_ = qEnvironmentVariable("MICROTONE_UPDATE_URL");
  if (manifest_ == u"none") {
    manifest_.clear();
  } else if (manifest_.isEmpty()) {
    QUrl url(QString::fromLatin1(kSite));
    QUrlQuery q;
    q.addQueryItem(QStringLiteral("channel"), channel_);
    q.addQueryItem(QStringLiteral("version"), kCurrent);
    q.addQueryItem(QStringLiteral("platform"), platformName());
    url.setQuery(q);
    manifest_ = url.toString(QUrl::FullyEncoded);
  }

  if (testRun_) {
    updatable_ = true;
    kind_ = QStringLiteral("installer");
  } else {
#if defined(Q_OS_WIN)
    // Where the installer says it put the app — not a copy run from a zip or
    // a build tree.
    QSettings uninstall(QStringLiteral("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
                                       "cc.microtone.desktop"),
                        QSettings::NativeFormat);
    const QString where = QFileInfo(uninstall.value(QStringLiteral("InstallLocation")).toString()).canonicalFilePath();
    const QString here = QFileInfo(QCoreApplication::applicationDirPath()).canonicalFilePath();
    updatable_ = !where.isEmpty() && where.compare(here, Qt::CaseInsensitive) == 0;
    if (updatable_) kind_ = QStringLiteral("installer");
#elif defined(Q_OS_MACOS)
    // An .app it may replace: not a disk image (read only), not a copy
    // Gatekeeper translocated to a random read-only place.
    const QString bundle = runningBundle();
    updatable_ = !bundle.isEmpty() && !bundle.contains(QStringLiteral("/AppTranslocation/")) &&
                 QFileInfo(bundle).isWritable() && QFileInfo(QFileInfo(bundle).absolutePath()).isWritable();
    if (updatable_) kind_ = QStringLiteral("bundle");
#else
    // An AppImage whose file and folder it may write: its file is replaced.
    // A .deb or .rpm install: its package is installed over it, through
    // pkexec. Anything else (a build tree) is only told.
    appImage_ = runningAppImage();
    if (!appImage_.isEmpty()) {
      const QFileInfo f(appImage_);
      if (f.isFile() && f.isWritable() && QFileInfo(f.absolutePath()).isWritable()) kind_ = QStringLiteral("appimage");
      // An update an earlier run prepared beside it and never put in place.
      for (const QFileInfo &left : QDir(f.absolutePath())
                                       .entryInfoList({QStringLiteral(".") + f.fileName() + QStringLiteral(".update-*")},
                                                      QDir::Files | QDir::Hidden)) {
        QFile::remove(left.filePath());
      }
    } else {
      const QString package = packageKind();
      if (!package.isEmpty() && (testSudo_ || !QStandardPaths::findExecutable(QStringLiteral("pkexec")).isEmpty()))
        kind_ = package;
    }
    updatable_ = !kind_.isEmpty();
#endif
  }
  if (manifest_.isEmpty()) qInfo("updates: not asked for (MICROTONE_UPDATE_URL=none)");
  else
    qInfo("updates: %s, channel %s", updatable_ ? qUtf8Printable(QStringLiteral("this copy can update itself (%1)").arg(kind_))
                                                : "this copy does not update itself: it is told of new versions",
          qUtf8Printable(channel_));
}

QJsonObject Updater::describe() const {
  return QJsonObject{{QStringLiteral("api"), QStringLiteral("/api/desktop/updates")},
                     {QStringLiteral("current"), kCurrent},
                     {QStringLiteral("channel"), channel_},
                     {QStringLiteral("updatable"), updatable_},
                     {QStringLiteral("kind"), kind_},
                     {QStringLiteral("asks"), !manifest_.isEmpty()}};
}

QJsonObject Updater::status() const {
  return QJsonObject{{QStringLiteral("state"), state_},
                     {QStringLiteral("current"), kCurrent},
                     {QStringLiteral("version"), version_},
                     {QStringLiteral("notes"), notes_},
                     {QStringLiteral("progress"), progress_},
                     {QStringLiteral("error"), error_},
                     {QStringLiteral("updatable"), updatable_},
                     {QStringLiteral("kind"), kind_},
                     {QStringLiteral("page"), page_},
                     {QStringLiteral("channel"), channel_},
                     {QStringLiteral("installOnQuit"), installOnQuit_}};
}

void Updater::setState(const QString &state, const QString &error) {
  state_ = state;
  error_ = error;
  if (!error.isEmpty()) qWarning("updates: %s", qUtf8Printable(error));
  emit changed();
}

bool Updater::newer(const QString &a, const QString &b) {
  static const QRegularExpression form(QStringLiteral(R"(^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$)"));
  const auto ma = form.match(a.trimmed()), mb = form.match(b.trimmed());
  if (!ma.hasMatch() || !mb.hasMatch()) return false;
  for (int i = 1; i <= 3; i++) {
    const qlonglong x = ma.captured(i).toLongLong(), y = mb.captured(i).toLongLong();
    if (x != y) return x > y;
  }
  const QString pa = ma.captured(4), pb = mb.captured(4);
  if (pa.isEmpty() || pb.isEmpty()) return pa.isEmpty() && !pb.isEmpty();  // 1.0.0 > 1.0.0-rc
  return pa > pb;  // rough, but releases here carry no pre-release tags
}

QStringList Updater::platformKeys() const {
#if defined(Q_OS_WIN)
  return {QStringLiteral("windows-x86_64-nsis"), QStringLiteral("windows-x86_64")};
#elif defined(Q_OS_MACOS)
  const bool arm = QSysInfo::currentCpuArchitecture().startsWith(QStringLiteral("arm"));
  return {QStringLiteral("darwin-universal"), arm ? QStringLiteral("darwin-aarch64") : QStringLiteral("darwin-x86_64")};
#else
  // A package installs only its own kind; a copy that is only told hears of
  // any Linux build.
  if (kind_ == u"deb" || kind_ == u"rpm") return {QStringLiteral("linux-x86_64-") + kind_};
  if (kind_ == u"appimage" || kind_ == u"installer")
    return {QStringLiteral("linux-x86_64-appimage"), QStringLiteral("linux-x86_64")};
  return {QStringLiteral("linux-x86_64-appimage"), QStringLiteral("linux-x86_64"), QStringLiteral("linux-x86_64-deb"),
          QStringLiteral("linux-x86_64-rpm")};
#endif
}

void Updater::check() {
  if (manifest_.isEmpty() || state_ == u"checking" || state_ == u"downloading" || state_ == u"ready") return;
  setState(QStringLiteral("checking"));
  QNetworkRequest request{QUrl(manifest_)};
  request.setHeader(QNetworkRequest::UserAgentHeader, QByteArray("Microtone-desktop/") + MICROTONE_VERSION);
  request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
  request.setTransferTimeout(30000);
  QNetworkReply *reply = net_.get(request);
  connect(reply, &QNetworkReply::finished, this, [this, reply] {
    reply->deleteLater();
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (status == 404) {  // no release on this channel has a manifest (yet)
      setState(QStringLiteral("none"));
      return;
    }
    if (reply->error() != QNetworkReply::NoError) {
      setState(QStringLiteral("error"), QStringLiteral("could not ask for updates: %1").arg(reply->errorString()));
      return;
    }
    const QJsonObject m = QJsonDocument::fromJson(reply->readAll()).object();
    const QString version = m.value(QStringLiteral("version")).toString();
    if (version.isEmpty()) {
      setState(QStringLiteral("error"), QStringLiteral("the update manifest is not one"));
      return;
    }
    if (!newer(version, kCurrent)) {
      setState(QStringLiteral("none"));
      return;
    }
    const QJsonObject platforms = m.value(QStringLiteral("platforms")).toObject();
    for (const QString &key : platformKeys()) {
      const QJsonObject entry = platforms.value(key).toObject();
      const QString url = entry.value(QStringLiteral("url")).toString();
      const QString signature = entry.value(QStringLiteral("signature")).toString();
      if (url.isEmpty() || signature.isEmpty()) continue;
      version_ = version;
      notes_ = m.value(QStringLiteral("notes")).toString();
      // Where to get it, for a copy that does not update itself: the
      // manifest's page when it gives one on the web, else the channel's.
      const QUrl page(m.value(QStringLiteral("page")).toString());
      page_ = page.isValid() && (page.scheme() == u"https" || page.scheme() == u"http") ? page.toString()
                                                                                       : defaultPage(channel_);
      url_ = url;
      signature_ = signature.toUtf8();
      qInfo("updates: %s is out (this is %s)", qUtf8Printable(version), qUtf8Printable(kCurrent));
      setState(QStringLiteral("available"));
      return;
    }
    setState(QStringLiteral("none"));  // nothing for this machine
  });
}

void Updater::download() {
  if (state_ != u"available" || !updatable_) return;
  QDir().mkpath(dir_);
#if defined(Q_OS_MACOS)
  const QString name = QStringLiteral("Microtone-%1.app.tar.gz").arg(version_);
#elif defined(Q_OS_WIN)
  const QString name = QStringLiteral("Microtone-%1-setup.exe").arg(version_);
#else
  const QString name = kind_ == u"appimage" ? QStringLiteral("Microtone-%1.AppImage").arg(version_)
                       : kind_ == u"deb"    ? QStringLiteral("Microtone-%1.deb").arg(version_)
                       : kind_ == u"rpm"    ? QStringLiteral("Microtone-%1.rpm").arg(version_)
                                            : QStringLiteral("Microtone-%1-update").arg(version_);
#endif
  const QString path = dir_ + u'/' + name;
  delete out_;
  out_ = new QFile(path, this);
  if (!out_->open(QIODevice::WriteOnly | QIODevice::Truncate)) {
    setState(QStringLiteral("error"), QStringLiteral("cannot write %1").arg(path));
    return;
  }
  progress_ = 0;
  setState(QStringLiteral("downloading"));
  QNetworkRequest request{QUrl(url_)};
  request.setHeader(QNetworkRequest::UserAgentHeader, QByteArray("Microtone-desktop/") + MICROTONE_VERSION);
  // GitHub's API asset links (Tauri's latest.json) answer the file itself only so.
  request.setRawHeader("Accept", "application/octet-stream");
  request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
  request.setTransferTimeout(60000);  // of silence, not of the whole download
  reply_ = net_.get(request);
  connect(reply_, &QNetworkReply::readyRead, this, [this] {
    if (reply_ && out_) out_->write(reply_->readAll());
  });
  connect(reply_, &QNetworkReply::downloadProgress, this, [this](qint64 got, qint64 total) {
    if (total <= 0) return;
    const double p = double(got) / double(total);
    if (p - progress_ >= 0.01 || p >= 1) {
      progress_ = p;
      emit changed();
    }
  });
  connect(reply_, &QNetworkReply::finished, this, [this, path] {
    QNetworkReply *reply = reply_;
    reply->deleteLater();
    out_->write(reply->readAll());
    const bool written = out_->flush();
    out_->close();
    if (reply->error() != QNetworkReply::NoError || !written) {
      QFile::remove(path);
      setState(QStringLiteral("error"), QStringLiteral("could not download the update: %1")
                                            .arg(written ? reply->errorString() : out_->errorString()));
      return;
    }
    file_ = path;
    verifyAndPrepare();
  });
}

void Updater::verifyAndPrepare() {
  QString why;
  const QByteArray keyText =
      qEnvironmentVariableIsSet("MICROTONE_UPDATE_KEY") ? qgetenv("MICROTONE_UPDATE_KEY") : QByteArray(kUpdateKey);
  const auto key = minisign::parsePublicKey(keyText, &why);
  QString trusted;
  if (!key || !minisign::verifyFile(*key, file_, signature_, &why, &trusted)) {
    QFile::remove(file_);
    file_.clear();
    setState(QStringLiteral("error"), QStringLiteral("the download is not signed by Microtone (%1)").arg(why));
    return;
  }
  qInfo("updates: %s downloaded and its signature checked (%s)", qUtf8Printable(version_), qUtf8Printable(trusted));
  progress_ = 1;
#if defined(Q_OS_MACOS)
  if (!testRun_) {
    // Unpacked now, so quitting is quick and nothing can fail half-way then.
    const QString into = dir_ + QStringLiteral("/new");
    QDir(into).removeRecursively();
    QDir().mkpath(into);
    auto *tar = new QProcess(this);
    connect(tar, &QProcess::finished, this, [this, tar, into](int code, QProcess::ExitStatus how) {
      tar->deleteLater();
      QString app;
      for (const QFileInfo &f : QDir(into).entryInfoList({QStringLiteral("*.app")}, QDir::Dirs | QDir::NoDotAndDotDot)) {
        if (QFileInfo(f.filePath() + QStringLiteral("/Contents/MacOS")).isDir()) app = f.filePath();
      }
      if (how != QProcess::NormalExit || code != 0 || app.isEmpty()) {
        setState(QStringLiteral("error"), QStringLiteral("could not unpack the update"));
        return;
      }
      prepared_ = app;
      setState(QStringLiteral("ready"));
    });
    tar->start(QStringLiteral("/usr/bin/tar"), {QStringLiteral("-xzf"), file_, QStringLiteral("-C"), into});
    return;
  }
#endif
#if defined(Q_OS_LINUX)
  if (kind_ == u"appimage") {
    // Beside the running AppImage now (the same folder, so putting it in
    // place at quit is a rename, which cannot fail half-way), executable as
    // the running one is.
    const QFileInfo running(appImage_);
    prepared_ = running.absolutePath() + QStringLiteral("/.") + running.fileName() +
                QStringLiteral(".update-%1").arg(QCoreApplication::applicationPid());
    QFile::remove(prepared_);
    if (!QFile::copy(file_, prepared_) ||
        !QFile::setPermissions(prepared_, QFile::permissions(appImage_) | QFileDevice::ExeOwner | QFileDevice::ReadOwner)) {
      QFile::remove(prepared_);
      prepared_.clear();
      setState(QStringLiteral("error"), QStringLiteral("could not put the update beside %1").arg(appImage_));
      return;
    }
    QFile::remove(file_);
    setState(QStringLiteral("ready"));
    return;
  }
#endif
  QFile::setPermissions(file_, QFile::permissions(file_) | QFileDevice::ExeOwner | QFileDevice::ExeUser);
  setState(QStringLiteral("ready"));
}

void Updater::installOnQuit(bool restart) {
  if (state_ != u"ready") return;
  installOnQuit_ = true;
  restart_ = restart;
  qInfo("updates: %s will be installed when the app quits%s", qUtf8Printable(version_),
        restart ? ", and the app started again" : "");
  emit changed();
}

void Updater::installNow() {
  if (!installOnQuit_) return;
  installOnQuit_ = false;
#if defined(Q_OS_MACOS)
  if (!testRun_) {
    const QString bundle = runningBundle();
    const QString old = bundle + QStringLiteral(".old-%1").arg(QCoreApplication::applicationPid());
    if (bundle.isEmpty() || !QDir().rename(bundle, old)) {
      qWarning("updates: could not move %s aside", qUtf8Printable(bundle));
      return;
    }
    bool placed = QDir().rename(prepared_, bundle);
    if (!placed) {  // another volume: copied, attributes and all
      placed = QProcess::execute(QStringLiteral("/usr/bin/ditto"), {prepared_, bundle}) == 0;
    }
    if (!placed) {
      QDir(bundle).removeRecursively();
      QDir().rename(old, bundle);
      qWarning("updates: could not put the new version in place; the old one stays");
      return;
    }
    // The old bundle goes once this process has (it is running from it), and
    // the new one starts then — not before, or it would find this one still
    // holding the instance socket and the browser profile.
    QProcess::startDetached(
        QStringLiteral("/bin/sh"),
        {QStringLiteral("-c"),
         QStringLiteral("while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; rm -rf \"$2\"; "
                        "if [ \"$3\" = 1 ]; then /usr/bin/open \"$4\"; fi"),
         QStringLiteral("sh"), QString::number(QCoreApplication::applicationPid()), old,
         restart_ ? QStringLiteral("1") : QStringLiteral("0"), bundle});
    qInfo("updates: %s is in place", qUtf8Printable(version_));
    return;
  }
#endif
#if defined(Q_OS_LINUX)
  // The helpers below wait for this process to end before they start
  // anything: the app's instance socket and browser profile are this one's
  // until then.
  const QString pid = QString::number(QCoreApplication::applicationPid());
  const QString restart = restart_ ? QStringLiteral("1") : QStringLiteral("0");
  if (kind_ == u"appimage") {
    // rename(2) replaces the name in one step; the running copy goes on
    // reading the file it opened.
    if (std::rename(QFile::encodeName(prepared_).constData(), QFile::encodeName(appImage_).constData()) != 0) {
      QFile::remove(prepared_);
      qWarning("updates: could not put %s in place of %s", qUtf8Printable(prepared_), qUtf8Printable(appImage_));
      return;
    }
    qInfo("updates: %s is in place", qUtf8Printable(version_));
    if (restart_) {
      // Started afresh, not as this one's child: what the AppImage runtime
      // set for this copy names this copy's mount.
      QProcess::startDetached(
          QStringLiteral("/bin/sh"),
          {QStringLiteral("-c"),
           QStringLiteral("while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; "
                          "exec env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD \"$2\""),
           QStringLiteral("sh"), pid, appImage_});
    }
    return;
  }
  if (kind_ == u"deb" || kind_ == u"rpm") {
    // The system's own installer, as an administrator: pkexec asks for the
    // password (the session's agent shows the prompt). Started again either
    // way, when asked — the old version if the install was refused.
    const QString install = kind_ == u"deb" ? QStringLiteral("dpkg -i") : QStringLiteral("rpm -U");
    const QString elevate = testSudo_ ? QStringLiteral("sudo -n") : QStringLiteral("pkexec");
    QProcess::startDetached(
        QStringLiteral("/bin/sh"),
        {QStringLiteral("-c"),
         QStringLiteral("while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; ") + elevate + u' ' + install +
             QStringLiteral(" \"$2\"; if [ \"$3\" = 1 ]; then exec \"$4\"; fi"),
         QStringLiteral("sh"), pid, file_, restart, QCoreApplication::applicationFilePath()});
    qInfo("updates: %s will be installed by %s once the app has quit", qUtf8Printable(version_), qUtf8Printable(install));
    return;
  }
#endif
  // Windows (and the test mode): the installer, which waits for this process.
  QStringList args{QStringLiteral("/P")};
  if (restart_) args << QStringLiteral("/R");
  if (!QProcess::startDetached(file_, args)) {
    qWarning("updates: could not start %s", qUtf8Printable(file_));
    return;
  }
  qInfo("updates: the installer of %s has started", qUtf8Printable(version_));
}

}  // namespace microtone
