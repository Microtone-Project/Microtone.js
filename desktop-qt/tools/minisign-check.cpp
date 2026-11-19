// Checks a minisign signature as the updater does (src/minisign.cpp):
//
//   minisign-check <public key> <file> <signature>
//
// The key and the signature are files, or text given as is; either may be in
// Tauri's form (the base64 of the key or signature file). Exit 0: good; 1:
// not (and why); 2: bad arguments. With no key given ("-"), the updater's own.
#include <QCoreApplication>
#include <QFile>

#include <cstdio>

#include "../src/minisign.h"
#include "../src/updatekey.h"

using namespace microtone;

static QByteArray textOf(const QString &arg) {
  QFile f(arg);
  if (f.exists() && f.open(QIODevice::ReadOnly)) return f.readAll();
  return arg.toUtf8();
}

int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  const QStringList args = app.arguments().mid(1);
  if (args.size() != 3) {
    std::fprintf(stderr, "usage: minisign-check <public key|-> <file> <signature>\n");
    return 2;
  }
  QString why;
  const auto key = minisign::parsePublicKey(args[0] == u"-" ? QByteArray(kUpdateKey) : textOf(args[0]), &why);
  if (!key) {
    std::fprintf(stderr, "the key: %s\n", qUtf8Printable(why));
    return 2;
  }
  QString trusted;
  if (!minisign::verifyFile(*key, args[1], textOf(args[2]), &why, &trusted)) {
    std::printf("BAD (key %s): %s\n", qUtf8Printable(key->id()), qUtf8Printable(why));
    return 1;
  }
  std::printf("good (key %s): %s\n", qUtf8Printable(key->id()), qUtf8Printable(trusted));
  return 0;
}
