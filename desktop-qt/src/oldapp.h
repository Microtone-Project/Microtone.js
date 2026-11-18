// What the earlier desktop app (the Tauri build, ../desktop) kept, read where
// it lies, and copied into ~/Microtone (FileStore runs copyOldApp at every
// start). Read only: nothing of the earlier app's is ever changed.
//
// It kept projects, soundfonts and keymaps in its webview's OPFS, under the
// origin its webview gave it, in whatever form that webview stores OPFS:
//
//   Linux    WebKitGTK: ~/.local/share/cc.microtone.desktop/storage/<salt>/<salt>/
//   macOS    WKWebView: ~/Library/WebKit/cc.microtone.desktop/…/<salt>/<salt>/
//            — WebKit keeps OPFS as plain files under their own names, in
//            FileSystem/, beside an `origin` file naming the origin
//            (tauri://localhost; a dev server's is http://127.0.0.1:1430)
//   Windows  WebView2 (Chromium): %LOCALAPPDATA%\cc.microtone.desktop\EBWebView\Default\File System
//            — Chromium keeps the bytes as numbered files (<dir>/t/00/00000001)
//            and the names and folders in a LevelDB index (<dir>/t/Paths); a
//            second LevelDB (Origins) says which <dir> is whose
//            ("ORIGIN:http_tauri.localhost_0"). Read with a LevelDB reader of
//            our own (logs, tables, Snappy, the manifest).
//
// The copy follows the earlier app's own hand-over (desktop/src/handover.rs
// and its glue), so the two can run in either order, or both: a file is
// created, or found already there with the same bytes; a copy is replaced
// only while it is still exactly what was copied; anything else goes beside
// it as "name (from the old app)". A record per destination folder
// (<app data>/oldapp-copy.json) says what went where, so an unchanged file is
// not looked at again and one changed in the earlier app arrives on the next
// start. Nothing is deleted anywhere.
//
// MICROTONE_OLDAPP_DIR=<dir> looks there instead ("none": nowhere), and
// MICROTONE_OLDAPP_ORIGIN=<text> picks the origin whose name holds it
// (default "tauri") — for tests.
#pragma once

#include <QHash>
#include <QList>
#include <QPair>
#include <QString>

#include <atomic>
#include <memory>

namespace microtone {

/** One thing the earlier app kept in a store. */
struct OldEntry {
  QString path;  // within the store, names joined by "/"
  QString file;  // where its bytes are on disk; empty for a folder
  bool folder = false;
  qint64 size = 0;
  qint64 mtime = 0;  // ms since the epoch
};

class OldApp {
 public:
  virtual ~OldApp() = default;

  /** The earlier app's storage on this computer, or null when there is none. */
  static std::unique_ptr<OldApp> find();

  /** "webkit" or "chromium". */
  virtual QString kind() const = 0;
  /** The folder it reads. */
  virtual QString where() const = 0;
  /** Everything in one of its stores ("projects", "soundfonts", "keymaps"),
   *  read afresh, sorted by path; empty when it has nothing there. */
  virtual QList<OldEntry> list(const QString &store, QString *error = nullptr) const = 0;
};

/** What a copy did. */
struct OldAppCopy {
  int projects = 0, soundfonts = 0, keymaps = 0;  // files written: new, replaced or beside
  int beside = 0;                                 // of those, put beside a file of the person's
  int failed = 0;                                 // could not be copied
  QString error;                                  // a store that could not be read, and why
};

/** Copy what `old` keeps into `stores` (store → folder) under `root`,
 *  remembering it in `recordFile`; stops between files once `cancel` is set. */
OldAppCopy copyOldApp(const OldApp &old, const QHash<QString, QString> &stores, const QString &root,
                      const QString &recordFile, const std::atomic<bool> &cancel);
/** Has the person been told about a copy into `root`? Tell them once. */
bool oldAppTold(const QString &recordFile, const QString &root);
void setOldAppTold(const QString &recordFile, const QString &root);

/** "bad:name?" → "bad_name_": a name every system can hold (the page's
 *  carry-over.js portableName and the glue's, rule for rule). */
QString oldAppPortableName(const QString &name);

namespace leveldb_read {
/** Every live key of the LevelDB database in `dir`, with its newest value:
 *  the manifest's tables and the logs after them, Snappy-compressed blocks
 *  included. False with `error` said when it cannot be read. */
bool readAll(const QString &dir, QList<QPair<QByteArray, QByteArray>> *out, QString *error);
/** Snappy's raw format. */
bool snappyDecompress(const QByteArray &in, QByteArray *out);
}  // namespace leveldb_read

}  // namespace microtone
