#include "online.h"

#include <QCryptographicHash>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHttpHeaders>
#include <QHttpServerRequest>
#include <QHttpServerResponder>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRandomGenerator>
#include <QUrl>
#include <QUrlQuery>

#include <memory>

#include "appserver.h"

namespace microtone {

namespace {

using Status = QHttpServerResponder::StatusCode;

/** A sign-in left half-way in the browser is abandoned after this. */
constexpr qint64 kSignInTtlMs = 30 * 60 * 1000;
/** A finished one still answers the browser coming back again for this long. */
constexpr qint64 kReturnTtlMs = 10 * 60 * 1000;
/** Sign-ins waited on at once, at most (the oldest gives way). */
constexpr qsizetype kMaxPending = 8;
/** The page's request headers that go on to the server; nothing else does. */
const char *const kForwarded[] = {"content-type", "if-match", "accept"};
/** …and the answer's that come back (the length is the responder's). */
const char *const kReturned[] = {"content-type", "etag"};

QByteArray randomB64url(int bytes) {
  QByteArray buf(bytes, Qt::Uninitialized);
  QRandomGenerator::system()->generate(reinterpret_cast<quint32 *>(buf.data()),
                                       reinterpret_cast<quint32 *>(buf.data() + bytes));
  return buf.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

QByteArray verbOf(QHttpServerRequest::Method m) {
  using M = QHttpServerRequest::Method;
  switch (m) {
    case M::Get: return "GET";
    case M::Put: return "PUT";
    case M::Delete: return "DELETE";
    case M::Post: return "POST";
    case M::Head: return "HEAD";
    case M::Patch: return "PATCH";
    case M::Options: return "OPTIONS";
    default: return {};
  }
}

QString esc(const QString &s) { return s.toHtmlEscaped(); }

/** The page the system's browser shows at the end, in both languages (it
 *  cannot know which the app is in). */
void page(QHttpServerResponder &r, Status status, const QString &en, const QString &ko) {
  const QString html = QStringLiteral(
                           "<!doctype html>\n<meta charset=\"utf-8\">\n"
                           "<meta name=\"viewport\" content=\"width=device-width\">\n"
                           "<meta name=\"color-scheme\" content=\"light dark\">\n<title>Microtone</title>\n"
                           "<p lang=\"en\">%1</p>\n<p lang=\"ko\">%2</p>\n")
                           .arg(en, ko);
  QHttpHeaders h;
  h.append(QHttpHeaders::WellKnownHeader::ContentType, "text/html; charset=utf-8");
  h.append(QHttpHeaders::WellKnownHeader::CacheControl, "no-store");
  h.append("Referrer-Policy", "no-referrer");
  r.write(html.toUtf8(), h, status);
}

/** A JSON error as the API gives one, so online.js reads its code. */
void apiError(QHttpServerResponder &r, Status status, const char *code) {
  QHttpHeaders h = appHeaders();
  h.append(QHttpHeaders::WellKnownHeader::ContentType, "application/json");
  r.write(QJsonDocument(QJsonObject{{QStringLiteral("error"), QLatin1String(code)}}).toJson(QJsonDocument::Compact), h,
          status);
}

}  // namespace

Online::Online(const QString &dataDir, QObject *parent) : QObject(parent) {
  server_ = qEnvironmentVariable("MICROTONE_ONLINE");
  while (server_.endsWith(u'/')) server_.chop(1);
  const bool site = server_.isEmpty();
  if (site) server_ = QStringLiteral("https://microtone.cc");
  tokenFile_ = dataDir + QStringLiteral("/online-token");
  if (!site) {
    tokenFile_ += u'-' + QString::fromLatin1(
                             QCryptographicHash::hash(server_.toUtf8(), QCryptographicHash::Sha256).toHex().left(12));
    qInfo("online: talking to %s", qUtf8Printable(server_));
  }
  QFile f(tokenFile_);
  if (f.open(QIODevice::ReadOnly)) token_ = f.readAll().trimmed();
}

QJsonObject Online::describe() const {
  return QJsonObject{{QStringLiteral("server"), server_},
                     {QStringLiteral("signIn"), QStringLiteral("/api/desktop/online-sign-in")}};
}

bool Online::handles(const QUrl &url) {
  const QString path = url.path();
  return path == u"/api/online" || path.startsWith(QStringLiteral("/api/online/"));
}

bool Online::apiPath(const QString &p) {
  return (p == u"/api/online" || p.startsWith(QStringLiteral("/api/online/")) ||
          p.startsWith(QStringLiteral("/api/online?"))) &&
         !p.contains(QStringLiteral("..")) && !p.contains(u'#') && !p.contains(u'\\') && !p.contains(u'@');
}

QByteArray Online::s256(const QByteArray &verifier) {
  return QCryptographicHash::hash(verifier, QCryptographicHash::Sha256)
      .toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals);
}

void Online::keepToken(const QByteArray &token) {
  token_ = token;
  if (token.isEmpty()) {
    QFile::remove(tokenFile_);
    return;
  }
  QDir().mkpath(QFileInfo(tokenFile_).absolutePath());
  // Readable by its owner only: it is as good as a password for the slots.
  QFile::remove(tokenFile_);
  QFile f(tokenFile_);
  if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate, QFileDevice::ReadOwner | QFileDevice::WriteOwner) ||
      f.write(token) != token.size()) {
    qWarning("online: could not keep the token: %s", qUtf8Printable(f.errorString()));
  }
}

void Online::handle(const QHttpServerRequest &request, QHttpServerResponder &responder) {
  const QUrl in = request.url();
  QString path = in.path(QUrl::FullyEncoded);
  if (in.hasQuery()) path += u'?' + in.query(QUrl::FullyEncoded);
  const QByteArray verb = verbOf(request.method());
  if (!apiPath(path) || verb.isEmpty()) {
    apiError(responder, Status::BadRequest, "bad-request");
    return;
  }

  QNetworkRequest out(QUrl(server_ + path));
  out.setHeader(QNetworkRequest::UserAgentHeader, QByteArrayLiteral("Microtone-desktop"));
  out.setTransferTimeout(120000);
  // The site's answer, not a redirect followed on the page's behalf; and no
  // cookies either way: the token is the session.
  out.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
  out.setAttribute(QNetworkRequest::CookieLoadControlAttribute, QNetworkRequest::Manual);
  out.setAttribute(QNetworkRequest::CookieSaveControlAttribute, QNetworkRequest::Manual);
  out.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
  out.setAttribute(QNetworkRequest::CacheSaveControlAttribute, false);
  for (const char *name : kForwarded) {
    const QByteArrayView value = request.headers().value(name);
    if (!value.isEmpty()) out.setRawHeader(name, value.toByteArray());
  }
  const QByteArray token = token_;
  if (!token.isEmpty()) out.setRawHeader("Authorization", "Bearer " + token);

  // Gone here whatever the server says: signing out must not depend on it.
  if (verb == "POST" && path.startsWith(QStringLiteral("/api/online/auth/logout"))) keepToken({});

  QNetworkReply *reply = net_.sendCustomRequest(out, verb, request.body());
  // The answer is written when the site's arrives: the responder waits with
  // it (Qt keeps the connection for it, even should the page leave).
  auto held = std::make_shared<QHttpServerResponder>(std::move(responder));
  connect(reply, &QNetworkReply::finished, this, [this, reply, held, token] {
    reply->deleteLater();
    const QVariant code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute);
    if (!code.isValid()) {
      // Never got an answer: what online.js calls "offline".
      qInfo("online: %s did not answer: %s", qUtf8Printable(server_), qUtf8Printable(reply->errorString()));
      apiError(*held, Status::BadGateway, "offline");
      return;
    }
    const int status = code.toInt();
    // Expired or ended elsewhere: a token the server no longer knows is no
    // token (unless a new one arrived meanwhile).
    if (status == 401 && !token.isEmpty() && token_ == token) keepToken({});
    QHttpHeaders h = appHeaders();
    for (const char *name : kReturned) {
      if (reply->hasRawHeader(name)) h.append(QByteArrayView(name), reply->rawHeader(name));
    }
    const QByteArray body = reply->readAll();
    held->write(body, h, static_cast<Status>(status));
  });
}

void Online::sweep() {
  for (auto it = pending_.begin(); it != pending_.end();) {
    it = it->started.elapsed() > kSignInTtlMs ? pending_.erase(it) : std::next(it);
  }
  for (auto it = returns_.begin(); it != returns_.end();) {
    it = it->done && it->finished.elapsed() > kReturnTtlMs ? returns_.erase(it) : std::next(it);
  }
}

bool Online::beginSignIn(quint16 port, QString *error) {
  sweep();
  while (pending_.size() >= kMaxPending) {
    auto oldest = pending_.begin();
    for (auto it = pending_.begin(); it != pending_.end(); ++it) {
      if (it->started.elapsed() > oldest->started.elapsed()) oldest = it;
    }
    pending_.erase(oldest);
  }
  Pending p;
  p.verifier = randomB64url(32);
  p.started.start();
  const QByteArray state = randomB64url(16);
  QUrlQuery q;
  q.addQueryItem(QStringLiteral("challenge"), QString::fromLatin1(s256(p.verifier)));
  q.addQueryItem(QStringLiteral("state"), QString::fromLatin1(state));
  q.addQueryItem(QStringLiteral("port"), QString::number(port));
  QUrl url(server_ + QStringLiteral("/api/online/auth/desktop"));
  url.setQuery(q);
  pending_.insert(state, std::move(p));
  // MICROTONE_BROWSER=<program>: that, with the address, instead of the
  // system's browser (tests play the browser's part).
  const QString browser = qEnvironmentVariable("MICROTONE_BROWSER");
  const bool opened = browser.isEmpty() ? QDesktopServices::openUrl(url)
                                        : QProcess::startDetached(browser, {url.toString(QUrl::FullyEncoded)});
  if (!opened) {
    pending_.remove(state);
    *error = QStringLiteral("could not open the browser");
    return false;
  }
  qInfo("online: signing in through the browser");
  return true;
}

void Online::finish(const QByteArray &state, bool ok, const QString &en, const QString &ko) {
  Return &r = returns_[state];
  r.done = true;
  r.ok = ok;
  r.en = en;
  r.ko = ko;
  r.finished.start();
  for (const auto &held : r.waiting) page(*held, ok ? Status::Ok : Status::BadGateway, en, ko);
  r.waiting.clear();
  if (!ok) return;
  // Signed in: the other sign-ins still out in a browser are answered the
  // same, their codes left to expire unspent.
  for (auto it = pending_.cbegin(); it != pending_.cend(); ++it) {
    Return &other = returns_[it.key()];
    other.done = true;
    other.ok = true;
    other.en = en;
    other.ko = ko;
    other.finished.start();
  }
  pending_.clear();
}

void Online::signedIn(const QHttpServerRequest &request, QHttpServerResponder &responder) {
  sweep();
  const QUrlQuery q(request.url());
  const QByteArray code = q.queryItemValue(QStringLiteral("code")).toLatin1();
  const QByteArray state = q.queryItemValue(QStringLiteral("state")).toLatin1();
  // Back again from a sign-in already on its way: the same outcome.
  if (auto r = returns_.find(state); !state.isEmpty() && r != returns_.end()) {
    qInfo("online: the browser came back again; it gets the same answer");
    if (r->done) {
      page(responder, r->ok ? Status::Ok : Status::BadGateway, r->en, r->ko);
    } else {
      r->waiting.push_back(std::make_shared<QHttpServerResponder>(std::move(responder)));
    }
    return;
  }
  // Ours, and recent; anything else is a link this app never asked for.
  const auto p = pending_.constFind(state);
  if (state.isEmpty() || p == pending_.cend() || code.isEmpty()) {
    qInfo("online: ignored a sign-in this app did not ask for (%s)",
          state.isEmpty() ? "no state" : code.isEmpty() ? "no code" : "an unknown state");
    page(responder, Status::BadRequest,
         QStringLiteral("This is not a sign-in Microtone is waiting for. Start again from the File view in Microtone."),
         QStringLiteral("Microtone이 기다리던 로그인이 아닙니다. Microtone의 파일 보기에서 다시 시작하세요."));
    return;
  }
  const QByteArray verifier = p->verifier;
  pending_.remove(state);
  returns_[state].waiting.push_back(std::make_shared<QHttpServerResponder>(std::move(responder)));

  QNetworkRequest out(QUrl(server_ + QStringLiteral("/api/online/auth/token")));
  out.setHeader(QNetworkRequest::ContentTypeHeader, QByteArrayLiteral("application/json"));
  out.setHeader(QNetworkRequest::UserAgentHeader, QByteArrayLiteral("Microtone-desktop"));
  out.setTransferTimeout(60000);
  out.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
  const QByteArray body = QJsonDocument(QJsonObject{{QStringLiteral("code"), QString::fromLatin1(code)},
                                                    {QStringLiteral("verifier"), QString::fromLatin1(verifier)}})
                              .toJson(QJsonDocument::Compact);
  QNetworkReply *reply = net_.post(out, body);
  connect(reply, &QNetworkReply::finished, this, [this, reply, state] {
    reply->deleteLater();
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QJsonObject granted = QJsonDocument::fromJson(reply->readAll()).object();
    const QByteArray token = granted.value(QStringLiteral("token")).toString().toLatin1();
    if (status != 200 || token.isEmpty()) {
      const QString why = status ? QStringLiteral("the server answered %1").arg(status) : reply->errorString();
      qWarning("online: the sign-in did not complete: %s", qUtf8Printable(why));
      finish(state, false,
             QStringLiteral("The sign-in did not complete (%1). Try again from the File view in Microtone.").arg(esc(why)),
             QStringLiteral("로그인을 마치지 못했습니다 (%1). Microtone의 파일 보기에서 다시 시도하세요.").arg(esc(why)));
      emit authChanged(QStringLiteral("sign-in-failed"));
      return;
    }
    keepToken(token);
    const QString name = esc(granted.value(QStringLiteral("user")).toObject().value(QStringLiteral("name")).toString());
    qInfo("online: signed in");
    finish(state, true,
           QStringLiteral("Signed in as <b>%1</b>. You can close this tab and go back to Microtone.").arg(name),
           QStringLiteral("<b>%1</b>(으)로 로그인했습니다. 이 탭을 닫고 Microtone으로 돌아가면 됩니다.").arg(name));
    emit authChanged(QStringLiteral("signed-in"));
  });
}

}  // namespace microtone
