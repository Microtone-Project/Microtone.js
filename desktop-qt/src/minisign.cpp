#include "minisign.h"

#include <QFile>
#include <QList>

#include <algorithm>

extern "C" {
#include "../vendor/monocypher/monocypher-ed25519.h"
#include "../vendor/monocypher/monocypher.h"
}

namespace microtone::minisign {

namespace {

const QByteArray kTrusted = QByteArrayLiteral("trusted comment: ");

bool fail(QString *error, const QString &why) {
  if (error) *error = why;
  return false;
}

QByteArray strictBase64(const QByteArray &text) {
  const auto r = QByteArray::fromBase64Encoding(text.trimmed(), QByteArray::AbortOnBase64DecodingErrors);
  return r ? r.decoded : QByteArray();
}

/** The lines of a minisign file, its own text or that text in base64. */
QList<QByteArray> linesOf(const QByteArray &text) {
  QByteArray t = text.trimmed();
  if (!t.startsWith("untrusted comment:")) {
    const QByteArray decoded = strictBase64(t);
    if (decoded.startsWith("untrusted comment:")) t = decoded;
  }
  QList<QByteArray> lines;
  for (const QByteArray &line : t.split('\n')) {
    QByteArray l = line;
    if (l.endsWith('\r')) l.chop(1);
    lines.append(l);
  }
  return lines;
}

}  // namespace

QString PublicKey::id() const {
  QByteArray be = keyId;
  std::reverse(be.begin(), be.end());
  return QString::fromLatin1(be.toHex().toUpper());
}

std::optional<PublicKey> parsePublicKey(const QByteArray &text, QString *error) {
  const QList<QByteArray> lines = linesOf(text);
  // A key file's second line, or the bare base64 line itself.
  const QByteArray line = lines.size() >= 2 && lines[0].startsWith("untrusted comment:") ? lines[1] : lines.value(0);
  const QByteArray raw = strictBase64(line);
  if (raw.size() != 42 || !raw.startsWith("Ed")) {
    fail(error, QStringLiteral("not a minisign public key"));
    return std::nullopt;
  }
  return PublicKey{raw.mid(2, 8), raw.mid(10, 32)};
}

bool verifyFile(const PublicKey &key, const QString &path, const QByteArray &signature, QString *error,
                QString *trusted) {
  const QList<QByteArray> lines = linesOf(signature);
  if (lines.size() < 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith(kTrusted))
    return fail(error, QStringLiteral("not a minisign signature"));
  const QByteArray sig = strictBase64(lines[1]);
  const QByteArray global = strictBase64(lines[3]);
  if (sig.size() != 74 || global.size() != 64) return fail(error, QStringLiteral("not a minisign signature"));
  const QByteArray algorithm = sig.left(2);
  if (algorithm != "ED" && algorithm != "Ed") return fail(error, QStringLiteral("an unknown signature algorithm"));
  if (sig.mid(2, 8) != key.keyId) return fail(error, QStringLiteral("signed with another key"));
  const auto *pk = reinterpret_cast<const uint8_t *>(key.key.constData());
  const auto *s = reinterpret_cast<const uint8_t *>(sig.constData() + 10);

  QFile file(path);
  if (!file.open(QIODevice::ReadOnly)) return fail(error, QStringLiteral("cannot read %1").arg(path));
  bool good;
  if (algorithm == "ED") {
    // Prehashed: the signature is over the file's BLAKE2b-512.
    crypto_blake2b_ctx ctx;
    crypto_blake2b_init(&ctx, 64);
    while (!file.atEnd()) {
      const QByteArray chunk = file.read(1 << 20);
      if (chunk.isEmpty()) return fail(error, QStringLiteral("cannot read %1").arg(path));
      crypto_blake2b_update(&ctx, reinterpret_cast<const uint8_t *>(chunk.constData()), size_t(chunk.size()));
    }
    uint8_t hash[64];
    crypto_blake2b_final(&ctx, hash);
    good = crypto_ed25519_check(s, pk, hash, sizeof hash) == 0;
  } else {
    const QByteArray all = file.readAll();
    good = crypto_ed25519_check(s, pk, reinterpret_cast<const uint8_t *>(all.constData()), size_t(all.size())) == 0;
  }
  if (!good) return fail(error, QStringLiteral("the signature does not match the file"));

  // The trusted comment (file name, time) is signed too, with the signature.
  const QByteArray comment = lines[2].mid(kTrusted.size());
  const QByteArray signedPart = sig.mid(10, 64) + comment;
  if (crypto_ed25519_check(reinterpret_cast<const uint8_t *>(global.constData()), pk,
                           reinterpret_cast<const uint8_t *>(signedPart.constData()), size_t(signedPart.size())) != 0)
    return fail(error, QStringLiteral("the trusted comment is not the one signed"));
  if (trusted) *trusted = QString::fromUtf8(comment);
  return true;
}

}  // namespace microtone::minisign
