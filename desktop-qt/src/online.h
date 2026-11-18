// Online projects (microtone-worker/server/online/), from the desktop app.
//
// The page is http://microtone.localhost and the API is https://microtone.cc:
// fetched by the page, a cross-site request, with a session cookie Chromium
// keeps from a third party. So the page fetches /api/online on its own origin
// as it does on the website (core/storage/online.js, unchanged), and this
// sends each request on to the site with the app's ACCESS TOKEN
// (`Authorization: Bearer`), and gives the answer back as it came.
//
// Signing in, RFC 8252 with PKCE (RFC 7636) — server/online/desktop.js is the
// other half, and the Tauri build's desktop/src/online.rs the older sibling:
//
//   POST /api/desktop/online-sign-in    the File view's "Sign in": a verifier
//                                       and a state are made and kept here,
//                                       and the system's browser opens
//                                       <server>/api/online/auth/desktop?
//                                       challenge=S256(verifier)&state=…&port=…
//   (the browser)                       is signed in there already, or signs
//                                       in, and is sent on to
//   GET http://127.0.0.1:<port>/signed-in?code=…&state=…
//                                       — this app's own server, the one page
//                                       it serves without its per-launch token
//                                       (RFC 8252 §7.3, loopback). The state
//                                       must be the one kept here; POST
//                                       /auth/token {code, verifier} gives the
//                                       token, kept in <app data>/online-token,
//                                       and the page hears "signed-in" on the
//                                       channel the website's own sign-in
//                                       window announces on.
//
// Not the Tauri build's cc.microtone.desktop: URI scheme: the two apps may be
// installed side by side for a while, and both claiming one scheme would hand
// each the other's sign-ins.
//
// MICROTONE_ONLINE=<url> talks to another server (`wrangler dev`); its token
// is kept apart from the site's, so pointing elsewhere never sends that one.
// MICROTONE_BROWSER=<program> is run with the sign-in's address instead of
// the system's browser (tests).
#pragma once

#include <QByteArray>
#include <QElapsedTimer>
#include <QHash>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QString>

#include <memory>
#include <vector>

class QHttpServerRequest;
class QHttpServerResponder;
class QUrl;

namespace microtone {

class Online : public QObject {
  Q_OBJECT
 public:
  explicit Online(const QString &dataDir, QObject *parent = nullptr);

  /** Is this the page's request to the online API (/api/online…)? */
  static bool handles(const QUrl &url);
  /** Send it on with the token; the answer comes back when the site's does. */
  void handle(const QHttpServerRequest &request, QHttpServerResponder &responder);

  /** Open the system's browser on the site's desktop sign-in, which comes
   *  back to http://127.0.0.1:<port>/signed-in. */
  bool beginSignIn(quint16 port, QString *error);
  /** That page, from the system's browser. */
  void signedIn(const QHttpServerRequest &request, QHttpServerResponder &responder);

  /** For the page (window.__MICROTONE_NATIVE__.online). */
  QJsonObject describe() const;

  /** Is the page's path one for the API, and nothing else? (For tests.) */
  static bool apiPath(const QString &pathAndQuery);
  /** RFC 7636 S256: BASE64URL(SHA-256(verifier)), unpadded. (For tests.) */
  static QByteArray s256(const QByteArray &verifier);

 signals:
  /** "signed-in" or "sign-in-failed", for the page (Shell::onlineAuth). */
  void authChanged(const QString &type);

 private:
  void keepToken(const QByteArray &token);

  QString server_;     // https://microtone.cc
  QString tokenFile_;  // <app data>/online-token
  QByteArray token_;
  QNetworkAccessManager net_;

  /** A sign-in this app started and is waiting on, by its state. Several may
   *  be: Sign in clicked again before the browser came up. */
  struct Pending {
    QByteArray verifier;
    QElapsedTimer started;
  };
  QHash<QByteArray, Pending> pending_;

  /** A sign-in the browser has come back from, by its state: while its code
   *  is being spent, every visit with that state waits for the outcome, and
   *  afterwards gets the same page. A browser may come back more than once
   *  (Firefox did, 0.7 s apart), and the visit it shows must not be the one
   *  that found the state already spent. */
  struct Return {
    std::vector<std::shared_ptr<QHttpServerResponder>> waiting;
    bool done = false;
    bool ok = false;
    QString en, ko;  // the page
    QElapsedTimer finished;
  };
  QHash<QByteArray, Return> returns_;

  void sweep();
  void finish(const QByteArray &state, bool ok, const QString &en, const QString &ko);
};

}  // namespace microtone
