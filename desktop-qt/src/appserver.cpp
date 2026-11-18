#include "appserver.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QHostAddress>
#include <QHttpHeaders>
#include <QHttpServerRequest>
#include <QHttpServerResponder>
#include <QHttpServerWebSocketUpgradeResponse>
#include <QTcpServer>
#include <QUrl>
#include <QUrlQuery>
#include <QWebSocket>
#if QT_VERSION >= QT_VERSION_CHECK(6, 11, 0)
#include <QHttpServerConfiguration>
#endif

#include "filestore.h"

namespace microtone {

namespace {

using Status = QHttpServerResponder::StatusCode;

}  // namespace

// Every response carries these. COOP + COEP make the page cross-origin
// isolated where the origin allows it; no-store because the files change
// under the same names with every update, and a cached old module next to a
// new one is a broken app.
QHttpHeaders appHeaders() {
  QHttpHeaders h;
  h.append("Cross-Origin-Opener-Policy", "same-origin");
  h.append("Cross-Origin-Embedder-Policy", "require-corp");
  h.append("Cross-Origin-Resource-Policy", "same-origin");
  h.append("Cache-Control", "no-store");
  h.append("X-Content-Type-Options", "nosniff");
  return h;
}

QByteArray mimeTypeFor(const QString &path) {
  static const QHash<QString, QByteArray> types = {
      {"html", "text/html; charset=utf-8"},
      {"js", "text/javascript; charset=utf-8"},
      {"mjs", "text/javascript; charset=utf-8"},
      {"css", "text/css; charset=utf-8"},
      {"json", "application/json"},
      {"webmanifest", "application/manifest+json"},
      {"md", "text/markdown; charset=utf-8"},
      {"txt", "text/plain; charset=utf-8"},
      {"tml", "text/plain; charset=utf-8"},
      {"py", "text/plain; charset=utf-8"},
      {"xml", "application/xml"},
      {"wasm", "application/wasm"},
      {"svg", "image/svg+xml"},
      {"png", "image/png"},
      {"jpg", "image/jpeg"},
      {"jpeg", "image/jpeg"},
      {"gif", "image/gif"},
      {"webp", "image/webp"},
      {"ico", "image/x-icon"},
      {"woff2", "font/woff2"},
      {"woff", "font/woff"},
      {"ttf", "font/ttf"},
      {"otf", "font/otf"},
      {"wav", "audio/wav"},
      {"ogg", "audio/ogg"},
      {"mp3", "audio/mpeg"},
      {"gz", "application/gzip"},
      {"zip", "application/zip"},
  };
  return types.value(QFileInfo(path).suffix().toLower(), "application/octet-stream");
}

QString resolvePath(const QString &root, const QString &urlPath) {
  if (!urlPath.startsWith(u'/')) return {};
  // Lexically, so the web app's own symlinks (core/ in a working tree) still
  // resolve; a path that climbs out of the root is refused before any file
  // is looked at.
  QString rel = QDir::cleanPath(urlPath);
  if (rel == u"/.." || rel.startsWith(u"/../") || rel.contains(u'\\')) return {};
  QString path = root + rel;
  if (urlPath.endsWith(u'/')) {
    if (!rel.endsWith(u'/')) path += u'/';
    path += QStringLiteral("index.html");
  }
  return path;
}

AppServer::AppServer(QString root, QByteArray token, QObject *parent)
    : QObject(parent), root_(std::move(root)), token_(std::move(token)) {
#if QT_VERSION >= QT_VERSION_CHECK(6, 11, 0)
  // Qt 6.11 refuses request bodies over 32 MiB (413) by default; a project
  // with its samples, or a converted soundfont, written to the file store is
  // the person's own and can be bigger. Qt 6.8 has no such limit.
  QHttpServerConfiguration config = http_.configuration();
  config.setMaximumBodySize(qint64(2) << 30);
  http_.setConfiguration(config);
#endif
  http_.setMissingHandler(this, [this](const QHttpServerRequest &request, QHttpServerResponder &responder) {
    handle(request, responder);
  });
  // The native audio host's socket: the page's own origin, with the token
  // the shell gave it (shell.cpp), and nothing else.
  http_.addWebSocketUpgradeVerifier(this, [this](const QHttpServerRequest &request) {
    if (request.url().path() != u"/engine") return QHttpServerWebSocketUpgradeResponse::passToNext();
    const QHttpHeaders &in = request.headers();
    const bool ok = engineSockets_ && in.value(QHttpHeaders::WellKnownHeader::Host) == kAppHost &&
                    in.value(QHttpHeaders::WellKnownHeader::Origin) == kAppOrigin &&
                    QUrlQuery(request.url()).queryItemValue(QStringLiteral("t")).toUtf8() == token_;
    return ok ? QHttpServerWebSocketUpgradeResponse::accept() : QHttpServerWebSocketUpgradeResponse::deny();
  });
  connect(&http_, &QAbstractHttpServer::newWebSocketConnection, this, [this] {
    while (std::unique_ptr<QWebSocket> socket = http_.nextPendingWebSocketConnection()) {
      if (engineSockets_) engineSockets_(std::move(socket));
    }
  });
}

void AppServer::setEngineSockets(std::function<void(std::unique_ptr<QWebSocket>)> sink) {
  engineSockets_ = std::move(sink);
}

bool AppServer::start() {
  tcp_ = new QTcpServer(this);
  if (!tcp_->listen(QHostAddress::LocalHost, 0)) return false;
  return http_.bind(tcp_);
}

quint16 AppServer::port() const { return tcp_ ? tcp_->serverPort() : 0; }

void AppServer::handle(const QHttpServerRequest &request, QHttpServerResponder &responder) const {
  const QHttpHeaders &in = request.headers();
  // The Host header names the origin the page was loaded from: anything else
  // is a page that resolved its own name to 127.0.0.1.
  const QByteArrayView host = in.value(QHttpHeaders::WellKnownHeader::Host);
  if (host != kAppHost || in.value(kTokenHeader) != token_) {
    responder.write(Status::Forbidden);
    return;
  }
  // The projects, soundfonts and keymaps (filestore.h).
  if (files_ != nullptr && FileStore::handles(request.url())) {
    files_->handle(request, responder);
    return;
  }
  const bool head = request.method() == QHttpServerRequest::Method::Head;
  if (!head && request.method() != QHttpServerRequest::Method::Get) {
    responder.write(Status::MethodNotAllowed);
    return;
  }

  const QUrl url = request.url();
  const QString path = resolvePath(root_, url.path());
  if (path.isEmpty()) {
    responder.write(Status::NotFound);
    return;
  }
  const QFileInfo info(path);
  if (info.isDir()) {
    // /docs → /docs/, so the index's relative links resolve inside it.
    QHttpHeaders h = appHeaders();
    QString to = url.path() + u'/';
    if (url.hasQuery()) to += u'?' + url.query(QUrl::FullyEncoded);
    h.append(QHttpHeaders::WellKnownHeader::Location, to.toUtf8());
    responder.write(h, Status::MovedPermanently);
    return;
  }
  auto *file = new QFile(path);
  if (!file->open(QIODevice::ReadOnly)) {
    delete file;
    responder.write(Status::NotFound);
    return;
  }
  QHttpHeaders h = appHeaders();
  h.append(QHttpHeaders::WellKnownHeader::ContentType, mimeTypeFor(path));
  if (head) {
    h.append(QHttpHeaders::WellKnownHeader::ContentLength, QByteArray::number(file->size()));
    delete file;
    responder.write(h, Status::Ok);
    return;
  }
  responder.write(file, h, Status::Ok);  // takes the file and closes it when sent
}

}  // namespace microtone
