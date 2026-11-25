#include "filestore.h"

#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHttpHeaders>
#include <QHttpServerRequest>
#include <QHttpServerResponder>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocale>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSet>
#include <QStringList>
#include <QUrl>
#include <QUrlQuery>

#include "appserver.h"
#include "oldapp.h"

namespace microtone {

namespace {

using Status = QHttpServerResponder::StatusCode;
constexpr QLatin1StringView kPrefix("/api/files/");

void say(QHttpServerResponder &r, Status status, const QString &why) {
  QHttpHeaders h = appHeaders();
  h.append(QHttpHeaders::WellKnownHeader::ContentType, "text/plain; charset=utf-8");
  r.write(why.toUtf8(), h, status);
}

void json(QHttpServerResponder &r, const QJsonObject &o) {
  QHttpHeaders h = appHeaders();
  h.append(QHttpHeaders::WellKnownHeader::ContentType, "application/json");
  r.write(QJsonDocument(o).toJson(QJsonDocument::Compact), h, Status::Ok);
}

/** A name that may be READ: anything but what leaves the folder. */
bool safeName(const QString &name) {
  if (name.isEmpty() || name == u"." || name == u"..") return false;
  for (QChar c : name) {
    if (c == u'/' || c == u'\\' || c.unicode() < 0x20) return false;
  }
  return true;
}

/** The names of a path, decoded one by one ("%2F" stays inside its name, and
 *  is then refused). Empty with `ok` false if any is not a safe name. */
QStringList namesOf(const QString &encoded, bool *ok) {
  QStringList names;
  *ok = true;
  if (encoded.isEmpty()) return names;
  for (const QString &part : encoded.split(u'/')) {
    const QString name = QUrl::fromPercentEncoding(part.toUtf8());
    if (!safeName(name)) {
      *ok = false;
      return {};
    }
    names << name;
  }
  return names;
}

/** Is `path` (which may not exist yet) inside `root`, symlinks followed? */
bool inside(const QString &root, const QString &path) {
  const QString top = QFileInfo(root).canonicalFilePath();
  if (top.isEmpty()) return false;
  QString at = path;
  while (!QFileInfo::exists(at)) {  // the nearest part of it that exists
    const QString up = QFileInfo(at).absolutePath();
    if (up == at) return false;
    at = up;
  }
  const QString real = QFileInfo(at).canonicalFilePath();
  return real == top || real.startsWith(top + u'/');
}

qint64 mtimeOf(const QFileInfo &f) { return f.lastModified().toMSecsSinceEpoch(); }

/** Every file and folder under `dir`, as paths from `top`: hidden ones (the
 *  system's .DS_Store, desktop.ini, …) left out, a folder reached twice
 *  through links walked once. */
void walk(const QString &dir, const QString &prefix, QJsonArray &files, QJsonArray &folders, QSet<QString> &seen,
          int depth) {
  const QString real = QFileInfo(dir).canonicalFilePath();
  if (depth > 32 || real.isEmpty() || seen.contains(real)) return;
  seen.insert(real);
  const QFileInfoList entries =
      QDir(dir).entryInfoList(QDir::Dirs | QDir::Files | QDir::NoDotAndDotDot, QDir::Name | QDir::IgnoreCase);
  for (const QFileInfo &e : entries) {
    const QString path = prefix.isEmpty() ? e.fileName() : prefix + u'/' + e.fileName();
    if (e.isDir()) {
      folders.append(path);
      walk(e.filePath(), path, files, folders, seen, depth + 1);
    } else {
      files.append(QJsonObject{{QStringLiteral("name"), path},
                               {QStringLiteral("size"), double(e.size())},
                               {QStringLiteral("mtime"), double(mtimeOf(e))}});
    }
  }
}

/** The folder as the person would write it: ~ for home except on Windows. */
QString shown(const QString &path) {
#ifdef Q_OS_WIN
  return QDir::toNativeSeparators(path);
#else
  const QString home = QDir::homePath();
  return path.startsWith(home + u'/') ? QStringLiteral("~") + path.mid(home.size()) : path;
#endif
}

}  // namespace

bool FileStore::portableName(const QString &name) {
  if (!safeName(name) || name.size() > 200) return false;
  static const QRegularExpression forbidden(QStringLiteral(R"([<>:"|?*])"));
  static const QRegularExpression reserved(QStringLiteral(R"(^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$)"),
                                           QRegularExpression::CaseInsensitiveOption);
  if (name.contains(forbidden) || name.contains(reserved)) return false;
  return !name.endsWith(u'.') && !name.endsWith(u' ') && name.trimmed() == name;
}

FileStore::FileStore(const QString &dataDir) {
  root_ = qEnvironmentVariable("MICROTONE_FILES_ROOT");
  if (root_.isEmpty()) root_ = QDir::homePath() + QStringLiteral("/Microtone");
  root_ = QDir::cleanPath(QDir(root_).absolutePath());
  stores_.insert(QStringLiteral("projects"), root_ + QStringLiteral("/Projects"));
  stores_.insert(QStringLiteral("soundfonts"), root_ + QStringLiteral("/Soundfonts"));
  stores_.insert(QStringLiteral("keymaps"), root_ + QStringLiteral("/Keymaps"));
  stores_.insert(QStringLiteral("instruments"), root_ + QStringLiteral("/Instruments"));
  stores_.insert(QStringLiteral("autosave"), dataDir + QStringLiteral("/autosave"));
  oldAppRecord_ = dataDir + QStringLiteral("/oldapp-copy.json");
  oldAppStatus_ = QJsonObject{{QStringLiteral("state"), QStringLiteral("done")}, {QStringLiteral("found"), false}};
  // Made now, so the person finds the folder where the app says it is.
  for (const QString &s : {QStringLiteral("projects"), QStringLiteral("soundfonts"), QStringLiteral("keymaps"),
                           QStringLiteral("instruments")})
    QDir().mkpath(stores_.value(s));
  qInfo("files: projects in %s", qUtf8Printable(QDir::toNativeSeparators(stores_.value(QStringLiteral("projects")))));
}

FileStore::~FileStore() {
  oldAppCancel_ = true;
  if (oldAppThread_.joinable()) oldAppThread_.join();
}

void FileStore::startOldAppCopy() {
  if (oldAppThread_.joinable()) return;
  {
    QMutexLocker lock(&oldAppLock_);
    oldAppStatus_ = QJsonObject{{QStringLiteral("state"), QStringLiteral("running")}};
  }
  // Its own copies of what it reads: the thread outlives no one, but owes
  // nothing to the server's.
  oldAppThread_ = std::thread([this, stores = stores_, root = root_, record = oldAppRecord_] {
    QJsonObject status{{QStringLiteral("state"), QStringLiteral("done")}, {QStringLiteral("found"), false}};
    const std::unique_ptr<OldApp> old = OldApp::find();
    if (!old) {
      qInfo("oldapp: the earlier desktop app's projects are not on this computer");
    } else {
      const OldAppCopy c = copyOldApp(*old, stores, root, record, oldAppCancel_);
      const int copied = c.projects + c.soundfonts + c.keymaps;
      qInfo("oldapp: %s at %s: copied %d projects, %d soundfonts, %d keymaps (%d beside); %d failed%s%s",
            qUtf8Printable(old->kind()), qUtf8Printable(QDir::toNativeSeparators(old->where())), c.projects,
            c.soundfonts, c.keymaps, c.beside, c.failed, c.error.isEmpty() ? "" : "; ", qUtf8Printable(c.error));
      status = QJsonObject{{QStringLiteral("state"), QStringLiteral("done")},
                           {QStringLiteral("found"), true},
                           {QStringLiteral("kind"), old->kind()},
                           {QStringLiteral("projects"), c.projects},
                           {QStringLiteral("soundfonts"), c.soundfonts},
                           {QStringLiteral("keymaps"), c.keymaps},
                           {QStringLiteral("beside"), c.beside},
                           {QStringLiteral("failed"), c.failed},
                           {QStringLiteral("error"), c.error},
                           {QStringLiteral("tell"), copied > 0 && !oldAppTold(record, root)}};
    }
    QMutexLocker lock(&oldAppLock_);
    oldAppStatus_ = status;
  });
}

void FileStore::handleOldApp(const QHttpServerRequest &request, QHttpServerResponder &responder) const {
  QMutexLocker lock(&oldAppLock_);
  if (request.method() == QHttpServerRequest::Method::Get) {
    json(responder, oldAppStatus_);
    return;
  }
  if (request.method() == QHttpServerRequest::Method::Post && QUrlQuery(request.url()).hasQueryItem(QStringLiteral("told"))) {
    if (oldAppStatus_.value(QStringLiteral("state")).toString() != u"done") {
      say(responder, Status::Conflict, QStringLiteral("still copying"));
      return;
    }
    setOldAppTold(oldAppRecord_, root_);
    oldAppStatus_.insert(QStringLiteral("tell"), false);
    responder.write(appHeaders(), Status::NoContent);
    return;
  }
  say(responder, Status::MethodNotAllowed, QStringLiteral("not something the store does"));
}

bool FileStore::handles(const QUrl &url) { return url.path().startsWith(kPrefix); }

QJsonObject FileStore::describe() const {
  return QJsonObject{
      {QStringLiteral("base"), QStringLiteral("/api/files")},
      {QStringLiteral("root"), shown(root_)},
      {QStringLiteral("projects"), shown(stores_.value(QStringLiteral("projects")))},
      {QStringLiteral("soundfonts"), shown(stores_.value(QStringLiteral("soundfonts")))},
      {QStringLiteral("keymaps"), shown(stores_.value(QStringLiteral("keymaps")))},
      {QStringLiteral("instruments"), shown(stores_.value(QStringLiteral("instruments")))},
  };
}

void FileStore::handle(const QHttpServerRequest &request, QHttpServerResponder &responder) const {
  using Method = QHttpServerRequest::Method;
  const Method method = request.method();
  // Writes come from the page itself, nothing else: its Origin says so (the
  // token, checked before this, says it is the app's own webview).
  if (method != Method::Get && method != Method::Head &&
      request.headers().value(QHttpHeaders::WellKnownHeader::Origin) != kAppOrigin) {
    say(responder, Status::Forbidden, QStringLiteral("not from the app"));
    return;
  }

  const QUrl url = request.url();
  const QString rest = url.path(QUrl::FullyEncoded).mid(kPrefix.size());
  const qsizetype slash = rest.indexOf(u'/');
  const QString storeName = slash < 0 ? rest : rest.left(slash);
  if (storeName == u"oldapp" && slash < 0) {
    handleOldApp(request, responder);
    return;
  }
  const QString top = stores_.value(storeName);
  if (top.isEmpty()) {
    say(responder, Status::NotFound, QStringLiteral("no store called %1").arg(storeName));
    return;
  }
  bool ok = true;
  const QStringList names = namesOf(slash < 0 ? QString() : rest.mid(slash + 1), &ok);
  if (!ok) {
    say(responder, Status::BadRequest, QStringLiteral("not a path in the store"));
    return;
  }
  const QString path = names.isEmpty() ? top : top + u'/' + names.join(u'/');
  const QUrlQuery query(url);
  QDir().mkpath(top);
  if (!inside(top, path)) {
    say(responder, Status::Forbidden, QStringLiteral("outside the store"));
    return;
  }
  const QFileInfo info(path);

  if (method == Method::Get || method == Method::Head) {
    if (query.hasQueryItem(QStringLiteral("list"))) {
      QJsonArray files, folders;
      QSet<QString> seen;
      if (info.isDir()) walk(path, QString(), files, folders, seen, 0);
      json(responder, QJsonObject{{QStringLiteral("files"), files}, {QStringLiteral("folders"), folders}});
      return;
    }
    if (!info.exists() || names.isEmpty()) {
      say(responder, Status::NotFound, QStringLiteral("not found"));
      return;
    }
    if (query.hasQueryItem(QStringLiteral("stat"))) {
      json(responder, QJsonObject{{QStringLiteral("kind"), info.isDir() ? QStringLiteral("directory") : QStringLiteral("file")},
                                  {QStringLiteral("size"), double(info.isDir() ? 0 : info.size())},
                                  {QStringLiteral("mtime"), double(mtimeOf(info))}});
      return;
    }
    if (info.isDir()) {
      say(responder, Status::BadRequest, QStringLiteral("a folder, not a file"));
      return;
    }
    auto *file = new QFile(path);
    if (!file->open(QIODevice::ReadOnly)) {
      delete file;
      say(responder, Status::InternalServerError, QStringLiteral("cannot read it"));
      return;
    }
    QHttpHeaders h = appHeaders();
    h.append(QHttpHeaders::WellKnownHeader::ContentType, "application/octet-stream");
    h.append(QHttpHeaders::WellKnownHeader::LastModified,
             QLocale::c().toString(info.lastModified().toUTC(), QStringLiteral("ddd, dd MMM yyyy hh:mm:ss 'GMT'")).toUtf8());
    if (method == Method::Head) {
      h.append(QHttpHeaders::WellKnownHeader::ContentLength, QByteArray::number(file->size()));
      delete file;
      responder.write(h, Status::Ok);
      return;
    }
    responder.write(file, h, Status::Ok);  // takes the file
    return;
  }

  // ── changes ──
  if (names.isEmpty() && !query.hasQueryItem(QStringLiteral("reveal"))) {
    say(responder, Status::BadRequest, QStringLiteral("the store itself cannot be changed"));
    return;
  }
  const bool creating = method == Method::Put || query.hasQueryItem(QStringLiteral("mkdir"));
  if (creating && !info.exists()) {
    for (const QString &n : names) {
      if (!portableName(n)) {
        say(responder, Status::BadRequest, QStringLiteral("\"%1\" is not a name every system can hold").arg(n));
        return;
      }
    }
  }

  if (method == Method::Put) {
    if (info.isDir()) {
      say(responder, Status::Conflict, QStringLiteral("a folder is there"));
      return;
    }
    QDir().mkpath(info.absolutePath());
    QSaveFile out(path);  // a new file, then renamed over the old: never half a project
    const QByteArray body = request.body();
    if (!out.open(QIODevice::WriteOnly) || out.write(body) != body.size() || !out.commit()) {
      say(responder, Status::InternalServerError, QStringLiteral("cannot write it: %1").arg(out.errorString()));
      return;
    }
    responder.write(appHeaders(), Status::NoContent);
    return;
  }

  if (method == Method::Delete) {
    if (!info.exists()) {
      say(responder, Status::NotFound, QStringLiteral("not found"));
      return;
    }
    bool done;
    if (info.isDir()) {
      done = query.hasQueryItem(QStringLiteral("recursive")) ? QDir(path).removeRecursively()
                                                             : QDir(info.absolutePath()).rmdir(info.fileName());
    } else {
      done = QFile::remove(path);
    }
    if (!done) {
      say(responder, Status::InternalServerError, QStringLiteral("cannot delete it"));
      return;
    }
    responder.write(appHeaders(), Status::NoContent);
    return;
  }

  if (method == Method::Post) {
    if (query.hasQueryItem(QStringLiteral("reveal"))) {
      const QString where = info.isDir() ? path : info.exists() ? info.absolutePath() : top;
      QDesktopServices::openUrl(QUrl::fromLocalFile(where));
      responder.write(appHeaders(), Status::NoContent);
      return;
    }
    if (query.hasQueryItem(QStringLiteral("mkdir"))) {
      if (info.exists() && !info.isDir()) {
        say(responder, Status::Conflict, QStringLiteral("a file is there"));
        return;
      }
      if (!QDir().mkpath(path)) {
        say(responder, Status::InternalServerError, QStringLiteral("cannot make the folder"));
        return;
      }
      responder.write(appHeaders(), Status::NoContent);
      return;
    }
    if (query.hasQueryItem(QStringLiteral("moveTo"))) {
      const QString to = query.queryItemValue(QStringLiteral("moveTo"), QUrl::FullyDecoded);
      const QStringList toNames = to.split(u'/', Qt::SkipEmptyParts);
      for (const QString &n : toNames) {
        if (!portableName(n)) {
          say(responder, Status::BadRequest, QStringLiteral("\"%1\" is not a name every system can hold").arg(n));
          return;
        }
      }
      const QString dest = top + u'/' + toNames.join(u'/');
      if (toNames.isEmpty() || !inside(top, dest)) {
        say(responder, Status::BadRequest, QStringLiteral("not a path in the store"));
        return;
      }
      if (!info.exists()) {
        say(responder, Status::NotFound, QStringLiteral("not found"));
        return;
      }
      // A case-only rename on a case-insensitive disk is the same file.
      if (QFileInfo::exists(dest) && QFileInfo(dest).canonicalFilePath() != info.canonicalFilePath()) {
        say(responder, Status::Conflict, QStringLiteral("something is already there"));
        return;
      }
      QDir().mkpath(QFileInfo(dest).absolutePath());
      if (!QDir().rename(path, dest)) {
        say(responder, Status::InternalServerError, QStringLiteral("cannot move it"));
        return;
      }
      responder.write(appHeaders(), Status::NoContent);
      return;
    }
  }
  say(responder, Status::MethodNotAllowed, QStringLiteral("not something the store does"));
}

}  // namespace microtone
