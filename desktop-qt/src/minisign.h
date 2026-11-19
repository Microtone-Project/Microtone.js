// Minisign signatures (https://jedisct1.github.io/minisign/), as the Tauri
// build's updater signs and checks them — and so as this build's does
// (updater.h): the same key signs both apps' updates, so the Tauri updater can
// one day install this app, and this app trusts nothing else.
//
//   public key   base64 of "Ed" ‖ key id (8) ‖ Ed25519 key (32), on the second
//                line of a key file; Tauri's config holds the base64 of that
//                whole file
//   signature    a file of four lines: an untrusted comment, base64 of
//                "ED" ‖ key id ‖ signature (64) — "ED": of the file's
//                BLAKE2b-512, "Ed" (legacy): of the file itself — then
//                "trusted comment: …" and base64 of a global signature over
//                signature ‖ trusted comment. Tauri's .sig (and latest.json's
//                "signature") is the base64 of that file.
//
// The Ed25519 and BLAKE2b are Monocypher's (vendor/monocypher).
#pragma once

#include <QByteArray>
#include <QString>

#include <optional>

namespace microtone::minisign {

struct PublicKey {
  QByteArray keyId;  // 8 bytes, as stored (little-endian)
  QByteArray key;    // 32 bytes
  /** The id as minisign prints it ("B118F2D437D85C50"). */
  QString id() const;
};

/** A public key from any of its forms: the key file's text, its base64 line,
 *  or the base64 of the key file (Tauri's `pubkey`). */
std::optional<PublicKey> parsePublicKey(const QByteArray &text, QString *error = nullptr);

/** Does `signature` (the signature file's text, or its base64 as Tauri gives
 *  it) sign the file at `path` with `key`? The key id, the file's signature
 *  and the global one over the trusted comment must all hold. The trusted
 *  comment comes back in `trusted`. */
bool verifyFile(const PublicKey &key, const QString &path, const QByteArray &signature, QString *error = nullptr,
                QString *trusted = nullptr);

}  // namespace microtone::minisign
