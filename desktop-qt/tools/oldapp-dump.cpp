// What the earlier desktop app kept, as the Qt build reads it (src/oldapp.cpp)
// — to test the reader on a real profile and for diagnostics:
//
//   oldapp-dump                    where it is and everything in its stores
//   oldapp-dump --copy <root>      copy it into <root>/{Projects,Soundfonts,Keymaps}
//                                  as the app does (record: <root>/oldapp-copy.json)
//   oldapp-dump --leveldb <dir>    every key and value of a LevelDB database
//   oldapp-dump --snappy <file>    a raw Snappy stream, decompressed to stdout
//
// MICROTONE_OLDAPP_DIR and MICROTONE_OLDAPP_ORIGIN pick the place, as in the
// app. Nothing it reads is changed.
#include <QCoreApplication>
#include <QDateTime>
#include <QFile>
#include <QHash>

#include <cstdio>

#include "../src/oldapp.h"

using namespace microtone;

static QByteArray shown(const QByteArray &b) {
  QByteArray out;
  for (char c : b) {
    const auto u = quint8(c);
    if (u >= 0x20 && u < 0x7f && c != '\\') out += c;
    else out += "\\x" + QByteArray::number(u, 16).rightJustified(2, '0');
  }
  return out;
}

int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  const QStringList args = app.arguments().mid(1);

  if (args.size() == 2 && args[0] == u"--leveldb") {
    QList<QPair<QByteArray, QByteArray>> rows;
    QString error;
    if (!leveldb_read::readAll(args[1], &rows, &error)) {
      std::fprintf(stderr, "cannot read it: %s\n", qUtf8Printable(error));
      return 1;
    }
    std::sort(rows.begin(), rows.end());
    for (const auto &[k, v] : rows) std::printf("%s = %s\n", shown(k).constData(), shown(v).constData());
    return 0;
  }
  if (args.size() == 2 && args[0] == u"--snappy") {
    QFile f(args[1]);
    QByteArray out;
    if (!f.open(QIODevice::ReadOnly) || !leveldb_read::snappyDecompress(f.readAll(), &out)) {
      std::fprintf(stderr, "not a Snappy stream\n");
      return 1;
    }
    std::fwrite(out.constData(), 1, size_t(out.size()), stdout);
    return 0;
  }

  const std::unique_ptr<OldApp> old = OldApp::find();
  if (!old) {
    std::printf("the earlier desktop app's storage is not on this computer\n");
    return 2;
  }
  std::printf("%s: %s\n", qUtf8Printable(old->kind()), qUtf8Printable(old->where()));

  if (args.size() == 2 && args[0] == u"--copy") {
    const QString root = args[1];
    const QHash<QString, QString> stores{{QStringLiteral("projects"), root + QStringLiteral("/Projects")},
                                         {QStringLiteral("soundfonts"), root + QStringLiteral("/Soundfonts")},
                                         {QStringLiteral("keymaps"), root + QStringLiteral("/Keymaps")}};
    std::atomic<bool> cancel{false};
    const OldAppCopy c = copyOldApp(*old, stores, root, root + QStringLiteral("/oldapp-copy.json"), cancel);
    std::printf("copied: %d projects, %d soundfonts, %d keymaps; %d beside; %d failed%s%s\n", c.projects,
                c.soundfonts, c.keymaps, c.beside, c.failed, c.error.isEmpty() ? "" : "; ",
                qUtf8Printable(c.error));
    return c.failed || !c.error.isEmpty() ? 1 : 0;
  }

  int status = 0;
  for (const QString &store : {QStringLiteral("projects"), QStringLiteral("soundfonts"), QStringLiteral("keymaps")}) {
    QString error;
    const QList<OldEntry> entries = old->list(store, &error);
    std::printf("[%s]%s%s\n", qUtf8Printable(store), error.isEmpty() ? "" : " cannot be read: ",
                qUtf8Printable(error));
    if (!error.isEmpty()) status = 1;
    for (const OldEntry &e : entries) {
      if (e.folder) {
        std::printf("  %s/\n", qUtf8Printable(e.path));
      } else {
        std::printf("  %s  %lld  %s  %s\n", qUtf8Printable(e.path), static_cast<long long>(e.size),
                    qUtf8Printable(QDateTime::fromMSecsSinceEpoch(e.mtime).toString(Qt::ISODate)),
                    qUtf8Printable(e.file));
      }
    }
  }
  return status;
}
