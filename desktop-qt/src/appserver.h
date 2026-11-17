// The loopback HTTP server the app is served from.
//
// Why a server and not a custom URL scheme: Chromium keeps the Origin Private
// File System — where every project lives — away from custom schemes (OPFS
// throws SecurityError under every QWebEngineUrlScheme flag set), and never
// cross-origin isolates them. Plain HTTP on loopback gets both.
//
// Why the origin carries no port: OPFS is keyed by the origin, so an origin
// that changed with the port would lose every project the day the port was
// taken. The page is loaded from http://microtone.localhost/ (port 80 as far
// as the origin is concerned) and Chromium's host-resolver rules send that
// name to whatever ephemeral port this server got (see main.cpp).
//
// Only the app's own webview may use it: the profile's request interceptor
// adds a per-launch token to every request (shell.cpp), and a request without
// it, or for another host name (a DNS-rebinding page), is refused.
#pragma once

#include <QByteArray>
#include <QHttpServer>
#include <QObject>
#include <QString>

class QTcpServer;
class QHttpServerRequest;
class QHttpServerResponder;

namespace microtone {

/** The app's origin, without a port: what the page's storage is keyed by. */
inline constexpr char kAppHost[] = "microtone.localhost";
/** The header the interceptor adds and the server demands. */
inline constexpr char kTokenHeader[] = "X-Microtone-Shell";

class AppServer : public QObject {
  Q_OBJECT
 public:
  /** Serves the files under `root` to requests carrying `token`. */
  AppServer(QString root, QByteArray token, QObject *parent = nullptr);

  /** Listens on 127.0.0.1 at a port the system picks. False on failure. */
  bool start();
  quint16 port() const;
  const QString &root() const { return root_; }

 private:
  void handle(const QHttpServerRequest &request, QHttpServerResponder &responder) const;

  QString root_;
  QByteArray token_;
  QHttpServer http_;
  QTcpServer *tcp_ = nullptr;
};

/** The Content-Type a file is served with, by its extension. */
QByteArray mimeTypeFor(const QString &path);

/** The file a URL path names under `root`, or an empty string when the path
 *  would leave it. A trailing slash names the directory's index.html. */
QString resolvePath(const QString &root, const QString &urlPath);

}  // namespace microtone
