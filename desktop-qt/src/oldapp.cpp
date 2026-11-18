#include "oldapp.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMultiHash>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSet>
#include <QStandardPaths>
#include <QStringList>
#include <QtEndian>

#include <algorithm>
#include <cstring>
#include <functional>
#include <optional>

namespace microtone {

// ── LevelDB, read only ──
//
// Enough of LevelDB's on-disk format (github.com/google/leveldb, doc/
// log_format.md and doc/table_format.md) to list a database: the MANIFEST says
// which table files are live and from which log on, the tables hold sorted
// internal keys (user key + 8 bytes of sequence << 8 | type) in blocks that
// may be Snappy-compressed, and the logs hold WriteBatches. The newest entry
// of each user key wins; a deletion removes it.

namespace leveldb_read {

namespace {

struct Reader {
  const char *p;
  const char *end;
  bool ok = true;

  explicit Reader(const QByteArray &b) : p(b.constData()), end(b.constData() + b.size()) {}
  Reader(const char *from, const char *to) : p(from), end(to) {}

  bool more() const { return ok && p < end; }

  quint64 varint() {
    quint64 v = 0;
    for (int shift = 0; shift <= 63; shift += 7) {
      if (p >= end) break;
      const quint8 b = quint8(*p++);
      v |= quint64(b & 0x7f) << shift;
      if ((b & 0x80) == 0) return v;
    }
    ok = false;
    return 0;
  }

  quint64 fixed(int bytes) {
    if (end - p < bytes) {
      ok = false;
      return 0;
    }
    quint64 v = 0;
    for (int i = 0; i < bytes; i++) v |= quint64(quint8(p[i])) << (8 * i);
    p += bytes;
    return v;
  }

  QByteArray bytes(quint64 n) {
    if (quint64(end - p) < n) {
      ok = false;
      return {};
    }
    QByteArray b(p, qsizetype(n));
    p += n;
    return b;
  }

  QByteArray lengthPrefixed() { return bytes(varint()); }
};

/** The records of a LevelDB log file (the database's logs and its MANIFEST):
 *  32 KiB blocks of fragments, put back together. A torn tail is dropped. */
QList<QByteArray> logRecords(const QByteArray &data) {
  constexpr qsizetype kBlock = 32768;
  constexpr qsizetype kHeader = 7;  // checksum (4), length (2), type (1)
  QList<QByteArray> records;
  QByteArray pending;
  bool inRecord = false;
  qsizetype at = 0;
  while (at < data.size()) {
    const qsizetype blockLeft = kBlock - at % kBlock;
    if (blockLeft < kHeader) {  // the block's zero trailer
      at += blockLeft;
      continue;
    }
    if (data.size() - at < kHeader) break;
    const quint8 *h = reinterpret_cast<const quint8 *>(data.constData() + at);
    const qsizetype length = h[4] | (h[5] << 8);
    const int type = h[6];
    if (type == 0 && length == 0) {  // preallocated zeros: the rest of the block
      at += blockLeft;
      continue;
    }
    if (kHeader + length > blockLeft || at + kHeader + length > data.size()) break;  // torn
    const QByteArray fragment = data.mid(at + kHeader, length);
    at += kHeader + length;
    switch (type) {
      case 1:  // FULL
        records.append(fragment);
        inRecord = false;
        break;
      case 2:  // FIRST
        pending = fragment;
        inRecord = true;
        break;
      case 3:  // MIDDLE
        if (inRecord) pending += fragment;
        break;
      case 4:  // LAST
        if (inRecord) records.append(pending + fragment);
        inRecord = false;
        break;
      default:
        inRecord = false;
        break;
    }
  }
  return records;
}

struct Entry {
  quint64 seq = 0;
  bool deleted = false;
  QByteArray value;
};

void put(QHash<QByteArray, Entry> &db, const QByteArray &key, quint64 seq, bool deleted, const QByteArray &value) {
  auto it = db.find(key);
  if (it != db.end() && it->seq > seq) return;
  db.insert(key, Entry{seq, deleted, value});
}

/** A WriteBatch: sequence (8), count (4), then puts and deletions. */
void applyBatch(const QByteArray &batch, QHash<QByteArray, Entry> &db) {
  Reader r(batch);
  quint64 seq = r.fixed(8);
  const quint64 count = r.fixed(4);
  for (quint64 i = 0; i < count && r.more(); i++, seq++) {
    const int tag = int(r.fixed(1));
    const QByteArray key = r.lengthPrefixed();
    if (tag == 1) {
      const QByteArray value = r.lengthPrefixed();
      if (r.ok) put(db, key, seq, false, value);
    } else if (tag == 0) {
      if (r.ok) put(db, key, seq, true, {});
    } else {
      return;
    }
  }
}

/** A table's block: its entries (prefix-compressed keys), handed to `each`. */
bool blockEntries(const QByteArray &block, const std::function<void(const QByteArray &, const QByteArray &)> &each) {
  if (block.size() < 4) return false;
  const quint32 restarts = qFromLittleEndian<quint32>(block.constData() + block.size() - 4);
  const qsizetype limit = block.size() - 4 - qsizetype(restarts) * 4;
  if (limit < 0) return false;
  Reader r(block.constData(), block.constData() + limit);
  QByteArray key;
  while (r.more()) {
    const quint64 shared = r.varint();
    const quint64 unshared = r.varint();
    const quint64 valueLength = r.varint();
    if (!r.ok || shared > quint64(key.size())) return false;
    key.truncate(qsizetype(shared));
    key += r.bytes(unshared);
    const QByteArray value = r.bytes(valueLength);
    if (!r.ok) return false;
    each(key, value);
  }
  return r.ok;
}

/** The block a handle names, decompressed (type 0: none, 1: Snappy). */
bool readBlock(const QByteArray &file, quint64 offset, quint64 size, QByteArray *out) {
  if (offset + size + 5 > quint64(file.size())) return false;  // + type and checksum
  const QByteArray raw = file.mid(qsizetype(offset), qsizetype(size));
  const int type = quint8(file.at(qsizetype(offset + size)));
  if (type == 0) {
    *out = raw;
    return true;
  }
  if (type == 1) return snappyDecompress(raw, out);
  return false;  // another compression (zstd): not something this reads
}

bool readTable(const QByteArray &file, QHash<QByteArray, Entry> &db, QString *error) {
  constexpr qsizetype kFooter = 48;
  if (file.size() < kFooter ||
      qFromLittleEndian<quint64>(file.constData() + file.size() - 8) != 0xdb4775248b80fb57ull) {
    *error = QStringLiteral("not a LevelDB table");
    return false;
  }
  Reader footer(file.constData() + file.size() - kFooter, file.constData() + file.size() - 8);
  footer.varint();  // the metaindex block's handle: not needed
  footer.varint();
  const quint64 indexOffset = footer.varint();
  const quint64 indexSize = footer.varint();
  QByteArray index;
  if (!footer.ok || !readBlock(file, indexOffset, indexSize, &index)) {
    *error = QStringLiteral("a table's index cannot be read");
    return false;
  }
  bool ok = true;
  const bool indexed = blockEntries(index, [&](const QByteArray &, const QByteArray &handle) {
    Reader h(handle);
    const quint64 offset = h.varint();
    const quint64 size = h.varint();
    QByteArray block;
    if (!h.ok || !readBlock(file, offset, size, &block)) {
      ok = false;
      return;
    }
    ok = blockEntries(block, [&](const QByteArray &internal, const QByteArray &value) {
           if (internal.size() < 8) return;
           const quint64 tail = qFromLittleEndian<quint64>(internal.constData() + internal.size() - 8);
           put(db, internal.left(internal.size() - 8), tail >> 8, (tail & 0xff) == 0, value);
         }) && ok;
  });
  if (!indexed || !ok) {
    *error = QStringLiteral("a table's blocks cannot be read (an unknown compression?)");
    return false;
  }
  return true;
}

QByteArray readFile(const QString &path) {
  QFile f(path);
  return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray();
}

}  // namespace

bool snappyDecompress(const QByteArray &in, QByteArray *out) {
  Reader r(in);
  const quint64 length = r.varint();
  if (!r.ok || length > (quint64(1) << 31)) return false;
  out->clear();
  out->reserve(qsizetype(length));
  while (r.more()) {
    const quint8 tag = quint8(r.fixed(1));
    quint64 len, offset;
    switch (tag & 3) {
      case 0: {  // a literal
        len = tag >> 2;
        if (len >= 60) len = r.fixed(int(len - 59));
        const QByteArray lit = r.bytes(len + 1);
        if (!r.ok) return false;
        out->append(lit);
        continue;
      }
      case 1:  // a copy, 11-bit offset
        len = ((tag >> 2) & 7) + 4;
        offset = (quint64(tag >> 5) << 8) | r.fixed(1);
        break;
      case 2:  // 16-bit offset
        len = (tag >> 2) + 1;
        offset = r.fixed(2);
        break;
      default:  // 32-bit offset
        len = (tag >> 2) + 1;
        offset = r.fixed(4);
        break;
    }
    if (!r.ok || offset == 0 || offset > quint64(out->size()) || quint64(out->size()) + len > length) return false;
    const qsizetype from = out->size() - qsizetype(offset);
    for (quint64 i = 0; i < len; i++) out->append(out->at(from + qsizetype(i)));  // may overlap itself
  }
  return r.ok && quint64(out->size()) == length;
}

bool readAll(const QString &dir, QList<QPair<QByteArray, QByteArray>> *out, QString *error) {
  QString why;
  QString &err = error ? *error : why;
  const QDir d(dir);
  // The manifest: which tables are live, and the first log still needed.
  QSet<quint64> tables;
  quint64 logFrom = 0, prevLog = 0;
  bool haveManifest = false;
  const QString current = QString::fromLatin1(readFile(d.filePath(QStringLiteral("CURRENT")))).trimmed();
  if (!current.isEmpty()) {
    for (const QByteArray &edit : logRecords(readFile(d.filePath(current)))) {
      Reader r(edit);
      QList<quint64> added, removed;
      while (r.more()) {
        switch (r.varint()) {
          case 1: r.lengthPrefixed(); break;              // comparator
          case 2: logFrom = r.varint(); break;            // log number
          case 3: r.varint(); break;                      // next file number
          case 4: r.varint(); break;                      // last sequence
          case 5: r.varint(); r.lengthPrefixed(); break;  // compact pointer
          case 6: r.varint(); removed.append(r.varint()); break;
          case 7:  // a new file: level, number, size, smallest, largest
            r.varint();
            added.append(r.varint());
            r.varint();
            r.lengthPrefixed();
            r.lengthPrefixed();
            break;
          case 9: prevLog = r.varint(); break;
          default: r.ok = false; break;
        }
      }
      if (!r.ok) break;
      for (quint64 n : removed) tables.remove(n);
      for (quint64 n : added) tables.insert(n);
      haveManifest = true;
    }
  }

  QHash<QByteArray, Entry> db;
  for (const QString &name : d.entryList(QDir::Files, QDir::Name)) {
    const qsizetype dot = name.lastIndexOf(u'.');
    bool numbered = false;
    const quint64 number = name.left(dot).toULongLong(&numbered);
    if (!numbered) continue;
    const QString suffix = name.mid(dot + 1);
    if (suffix == u"ldb" || suffix == u"sst") {
      if (haveManifest && !tables.contains(number)) continue;  // compacted away
      if (!readTable(readFile(d.filePath(name)), db, &err)) {
        err = QStringLiteral("%1: %2").arg(name, err);
        return false;
      }
      tables.remove(number);
    } else if (suffix == u"log") {
      if (haveManifest && number < logFrom && number != prevLog) continue;
      for (const QByteArray &batch : logRecords(readFile(d.filePath(name)))) applyBatch(batch, db);
    }
  }
  if (haveManifest && !tables.isEmpty()) {
    err = QStringLiteral("table %1 is missing").arg(*tables.cbegin());
    return false;
  }
  out->clear();
  for (auto it = db.cbegin(); it != db.cend(); ++it) {
    if (!it->deleted) out->append({it.key(), it->value});
  }
  return true;
}

}  // namespace leveldb_read

// ── the earlier app's storage ──

namespace {

/** WebKit: plain files under their own names. */
class WebKitStore : public OldApp {
 public:
  explicit WebKitStore(QString fileSystem) : fs_(std::move(fileSystem)) {}
  QString kind() const override { return QStringLiteral("webkit"); }
  QString where() const override { return fs_; }

  QList<OldEntry> list(const QString &store, QString *) const override {
    QList<OldEntry> out;
    const QDir top(fs_ + u'/' + store);
    if (!top.exists()) return out;
    QDirIterator it(top.path(), QDir::Dirs | QDir::Files | QDir::NoDotAndDotDot | QDir::Hidden,
                    QDirIterator::Subdirectories);
    while (it.hasNext()) {
      const QFileInfo f(it.next());
      if (f.isSymLink()) continue;
      OldEntry e;
      e.path = top.relativeFilePath(f.filePath());
      e.folder = f.isDir();
      if (!e.folder) {
        e.file = f.filePath();
        e.size = f.size();
      }
      e.mtime = f.lastModified().toMSecsSinceEpoch();
      out.append(e);
    }
    std::sort(out.begin(), out.end(), [](const OldEntry &a, const OldEntry &b) { return a.path < b.path; });
    return out;
  }

 private:
  QString fs_;  // …/<salt>/<salt>/FileSystem
};

/** Chromium: numbered files and a LevelDB index of names. */
class ChromiumStore : public OldApp {
 public:
  explicit ChromiumStore(QString typeDir) : dir_(std::move(typeDir)) {}
  QString kind() const override { return QStringLiteral("chromium"); }
  QString where() const override { return dir_; }

  QList<OldEntry> list(const QString &store, QString *error) const override {
    QList<OldEntry> out;
    QList<QPair<QByteArray, QByteArray>> rows;
    if (!leveldb_read::readAll(dir_ + QStringLiteral("/Paths"), &rows, error)) return out;
    // "CHILD_OF:<parent>:<name>" → "<child id>"; "<id>" → its FileInfo, a
    // base::Pickle (sandbox_directory_database.cc): a 4-byte payload size,
    // then int64 parent, string data path (empty for a folder), string name,
    // int64 time, each field aligned to 4 bytes.
    QMultiHash<qint64, QPair<QString, qint64>> children;
    QHash<qint64, QString> dataPath;
    for (const auto &[key, value] : rows) {
      if (key.startsWith("CHILD_OF:")) {
        const qsizetype colon = key.indexOf(':', 9);
        if (colon < 0) continue;
        bool ok1 = false, ok2 = false;
        const qint64 parent = key.mid(9, colon - 9).toLongLong(&ok1);
        const qint64 child = value.toLongLong(&ok2);
        if (ok1 && ok2) children.insert(parent, {QString::fromUtf8(key.mid(colon + 1)), child});
        continue;
      }
      bool numeric = false;
      const qint64 id = key.toLongLong(&numeric);
      if (!numeric || value.size() < 16) continue;
      const char *p = value.constData() + 4 + 8;  // past the size and the parent
      const char *end = value.constData() + value.size();
      const qint32 length = qFromLittleEndian<qint32>(p);
      p += 4;
      if (length < 0 || end - p < length) continue;
      QString path = QString::fromUtf8(p, length);
      path.replace(u'\\', u'/');  // Windows writes its own separator
      dataPath.insert(id, path);
    }
    // The store's folder among the root's children (the root is 0).
    qint64 top = -1;
    for (auto it = children.constFind(0); it != children.cend() && it.key() == 0; ++it) {
      if (it->first == store) top = it->second;
    }
    if (top < 0) return out;
    QSet<qint64> seen;
    std::function<void(qint64, const QString &)> walk = [&](qint64 id, const QString &prefix) {
      if (seen.contains(id) || seen.size() > 1000000) return;
      seen.insert(id);
      for (auto it = children.constFind(id); it != children.cend() && it.key() == id; ++it) {
        OldEntry e;
        e.path = prefix.isEmpty() ? it->first : prefix + u'/' + it->first;
        const QString data = dataPath.value(it->second);
        if (data.isEmpty()) {
          e.folder = true;
          out.append(e);
          walk(it->second, e.path);
          continue;
        }
        const QFileInfo f(dir_ + u'/' + data);
        if (!f.isFile()) continue;
        e.file = f.filePath();
        e.size = f.size();
        e.mtime = f.lastModified().toMSecsSinceEpoch();
        out.append(e);
      }
    };
    walk(top, QString());
    std::sort(out.begin(), out.end(), [](const OldEntry &a, const OldEntry &b) { return a.path < b.path; });
    return out;
  }

 private:
  QString dir_;  // …/File System/<dir>/t
};

/** Under `base`, the Chromium profile's OPFS folder for the origin whose name
 *  holds `want` (the profile may be `base` or a few folders down). */
QString findChromium(const QString &base, const QByteArray &want) {
  QStringList fileSystems;
  if (QFileInfo(base + QStringLiteral("/File System/Origins")).isDir()) fileSystems << base + QStringLiteral("/File System");
  QDirIterator it(base, QDir::Dirs | QDir::NoDotAndDotDot, QDirIterator::Subdirectories);
  while (it.hasNext()) {
    const QString dir = it.next();
    if (QDir(base).relativeFilePath(dir).count(u'/') > 3) continue;
    if (QFileInfo(dir).fileName() == u"File System" && QFileInfo(dir + QStringLiteral("/Origins")).isDir() &&
        !fileSystems.contains(dir))
      fileSystems << dir;
  }
  for (const QString &fs : fileSystems) {
    QList<QPair<QByteArray, QByteArray>> rows;
    if (!leveldb_read::readAll(fs + QStringLiteral("/Origins"), &rows, nullptr)) continue;
    for (const auto &[key, value] : rows) {
      if (!key.startsWith("ORIGIN:") || !key.contains(want)) continue;
      const QString t = fs + u'/' + QString::fromUtf8(value) + QStringLiteral("/t");
      if (QFileInfo(t + QStringLiteral("/Paths")).isDir()) return t;
    }
  }
  return {};
}

/** Under `base`, the WebKit origin folder whose `origin` names `want`: its
 *  FileSystem. */
QString findWebKit(const QString &base, const QByteArray &want) {
  QDirIterator it(base, {QStringLiteral("origin")}, QDir::Files, QDirIterator::Subdirectories);
  while (it.hasNext()) {
    const QString originFile = it.next();
    const QString dir = QFileInfo(originFile).absolutePath();
    if (QDir(base).relativeFilePath(dir).count(u'/') > 8) continue;
    const QString fs = dir + QStringLiteral("/FileSystem");
    if (!QFileInfo(fs).isDir()) continue;
    QFile f(originFile);
    if (f.open(QIODevice::ReadOnly) && f.read(4096).contains(want)) return fs;
  }
  return {};
}

}  // namespace

std::unique_ptr<OldApp> OldApp::find() {
  const QByteArray want = qEnvironmentVariableIsSet("MICROTONE_OLDAPP_ORIGIN") ? qgetenv("MICROTONE_OLDAPP_ORIGIN")
                                                                              : QByteArrayLiteral("tauri");
  QString base = qEnvironmentVariable("MICROTONE_OLDAPP_DIR");
  if (base == u"none") return nullptr;
  if (base.isEmpty()) {
#if defined(Q_OS_WIN)
    // %LOCALAPPDATA%\cc.microtone.desktop (WebView2's EBWebView\Default inside)
    base = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation) + QStringLiteral("/cc.microtone.desktop");
#elif defined(Q_OS_MACOS)
    base = QDir::homePath() + QStringLiteral("/Library/WebKit/cc.microtone.desktop");
#else
    base = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation) + QStringLiteral("/cc.microtone.desktop");
#endif
  }
  if (!QFileInfo(base).isDir()) return nullptr;
  const QString chromium = findChromium(base, want);
  if (!chromium.isEmpty()) return std::make_unique<ChromiumStore>(chromium);
  const QString webkit = findWebKit(base, want);
  if (!webkit.isEmpty()) return std::make_unique<WebKitStore>(webkit);
  return nullptr;
}

// ── the copy ──

QString oldAppPortableName(const QString &name) {
  static const QRegularExpression bad(QStringLiteral(R"([<>:"|?*\\/\x00-\x1f])"));
  static const QRegularExpression tail(QStringLiteral(R"([. ]+$)"));
  static const QRegularExpression reserved(QStringLiteral(R"(^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$)"),
                                           QRegularExpression::CaseInsensitiveOption);
  QString n = name;
  n.replace(bad, QStringLiteral("_"));
  n.remove(tail);
  if (reserved.match(n).hasMatch()) n.prepend(u'_');
  return n.isEmpty() ? QStringLiteral("_") : n;
}

namespace {

QString portablePath(const QString &path) {
  QStringList names = path.split(u'/');
  for (QString &n : names) n = oldAppPortableName(n);
  return names.join(u'/');
}

/** "Album/song.taud" → "Album/song (from the old app).taud" (the glue's). */
QString besideName(const QString &path) {
  const qsizetype at = path.lastIndexOf(u'/');
  const QString folder = path.left(at + 1);
  const QString name = path.mid(at + 1);
  const qsizetype dot = name.indexOf(u'.', 1);
  const QString mark = QStringLiteral(" (from the old app)");
  return dot < 0 ? folder + name + mark : folder + name.left(dot) + mark + name.mid(dot);
}

/** A JSON object from a file: empty when there is no file, nothing when it
 *  cannot be read or is not an object. */
std::optional<QJsonObject> readJson(const QString &path) {
  QFile f(path);
  if (!f.exists()) return QJsonObject();
  if (!f.open(QIODevice::ReadOnly)) return std::nullopt;
  QJsonParseError e;
  const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &e);
  if (e.error != QJsonParseError::NoError || !doc.isObject()) return std::nullopt;
  return doc.object();
}

bool writeJson(const QString &path, const QJsonObject &o) {
  QDir().mkpath(QFileInfo(path).absolutePath());
  QSaveFile out(path);
  const QByteArray bytes = QJsonDocument(o).toJson(QJsonDocument::Indented);
  return out.open(QIODevice::WriteOnly) && out.write(bytes) == bytes.size() && out.commit();
}

qint64 mtimeOf(const QString &path) { return QFileInfo(path).lastModified().toMSecsSinceEpoch(); }

bool sameBytes(const QString &a, const QString &b) {
  QFile fa(a), fb(b);
  if (fa.size() != fb.size() || !fa.open(QIODevice::ReadOnly) || !fb.open(QIODevice::ReadOnly)) return false;
  while (!fa.atEnd()) {
    if (fa.read(1 << 20) != fb.read(1 << 20)) return false;
  }
  return true;
}

bool copyInto(QIODevice &out, const QString &src) {
  QFile in(src);
  if (!in.open(QIODevice::ReadOnly)) return false;
  while (!in.atEnd()) {
    const QByteArray chunk = in.read(1 << 20);
    if (chunk.isEmpty() || out.write(chunk) != chunk.size()) return false;
  }
  return true;
}

struct Put {
  bool written = false;  // created or replaced
  bool same = false;     // already there, byte for byte
  bool failed = false;   // the copy itself went wrong
  qint64 mtime = 0;      // the file's, now
};

/** Create `dest` from `src`, or replace it when `replace` is the modification
 *  time it still has; neither written nor the same: someone else's file. */
Put putFile(const QString &dest, const QString &src, std::optional<qint64> replace) {
  Put r;
  const QFileInfo d(dest);
  if (d.isDir()) return r;
  if (d.exists()) {
    r.mtime = d.lastModified().toMSecsSinceEpoch();
    if (sameBytes(dest, src)) {
      r.same = true;
      return r;
    }
    if (!replace || *replace != r.mtime) return r;
    QSaveFile out(dest);  // a new file renamed over the old: never half a project
    if (!out.open(QIODevice::WriteOnly) || !copyInto(out, src) || !out.commit()) {
      r.failed = true;
      return r;
    }
  } else {
    if (!QDir().mkpath(d.absolutePath())) {
      r.failed = true;
      return r;
    }
    // Written beside it, then renamed in; a rename never replaces, so a file
    // that arrived meanwhile is left alone.
    const QString part =
        d.absolutePath() + QStringLiteral("/.%1.part-%2").arg(d.fileName()).arg(QCoreApplication::applicationPid());
    QFile out(part);
    const bool copied = out.open(QIODevice::WriteOnly) && copyInto(out, src) && out.flush();
    out.close();
    if (!copied) {
      QFile::remove(part);
      r.failed = true;
      return r;
    }
    if (!QFile::rename(part, dest)) {
      QFile::remove(part);
      return r;
    }
  }
  r.written = true;
  r.mtime = mtimeOf(dest);
  return r;
}

}  // namespace

bool oldAppTold(const QString &recordFile, const QString &root) {
  const auto all = readJson(recordFile);
  return all && all->value(root).toObject().value(QStringLiteral("told")).toBool();
}

void setOldAppTold(const QString &recordFile, const QString &root) {
  auto all = readJson(recordFile);
  if (!all) return;
  QJsonObject mine = all->value(root).toObject();
  mine.insert(QStringLiteral("told"), true);
  all->insert(root, mine);
  writeJson(recordFile, *all);
}

OldAppCopy copyOldApp(const OldApp &old, const QHash<QString, QString> &stores, const QString &root,
                      const QString &recordFile, const std::atomic<bool> &cancel) {
  OldAppCopy result;
  // The record: { "<root>": { told, files: { "<store>/<path>": { src, size, dst, to } } } }
  // — src and size the earlier app's file when copied, dst the copy's time.
  auto all = readJson(recordFile);
  if (!all) {
    result.error = QStringLiteral("the record %1 cannot be read").arg(recordFile);
    return result;
  }
  QJsonObject mine = all->value(root).toObject();
  QJsonObject files = mine.value(QStringLiteral("files")).toObject();
  const auto keep = [&] {
    mine.insert(QStringLiteral("files"), files);
    all->insert(root, mine);
    writeJson(recordFile, *all);
  };
  const auto number = [](const QJsonObject &o, const char *name) {
    return qint64(o.value(QLatin1String(name)).toDouble(-1));
  };
  const QString kIndex = QStringLiteral("index.json");
  std::optional<OldEntry> index;

  for (const QString &store : {QStringLiteral("projects"), QStringLiteral("soundfonts"), QStringLiteral("keymaps")}) {
    const QString top = stores.value(store);
    if (top.isEmpty()) continue;
    QString error;
    const QList<OldEntry> entries = old.list(store, &error);
    if (!error.isEmpty()) {
      result.error = QStringLiteral("%1: %2").arg(store, error);
      qWarning("oldapp: %s cannot be read: %s", qUtf8Printable(store), qUtf8Printable(error));
      continue;
    }
    const bool deep = store == u"projects";  // the others are flat, as the page keeps them
    int &count = store == u"projects" ? result.projects : store == u"soundfonts" ? result.soundfonts : result.keymaps;
    for (const OldEntry &e : entries) {
      if (cancel) return result;
      if (!deep && (e.folder || e.path.contains(u'/'))) continue;
      if (e.path.endsWith(QStringLiteral(".crswap"))) continue;  // Chromium's file being written
      if (e.folder) {
        QDir().mkpath(top + u'/' + portablePath(e.path));
        continue;
      }
      if (store == u"soundfonts" && e.path == kIndex) {
        index = e;  // merged below
        continue;
      }
      const QString key = store + u'/' + e.path;
      const QJsonObject was = files.value(key).toObject();
      if (!was.isEmpty() && number(was, "src") == e.mtime && number(was, "size") == e.size) continue;  // unchanged
      QString to = was.isEmpty() ? portablePath(e.path) : was.value(QStringLiteral("to")).toString();
      Put done = putFile(top + u'/' + to, e.file, was.isEmpty() ? std::nullopt : std::optional(number(was, "dst")));
      bool besideIt = false;
      if (!done.failed && !done.written && !done.same) {
        // Someone else's file there, or the copy changed since: beside the
        // original name (never beside a copy beside it).
        to = besideName(portablePath(e.path));
        done = putFile(top + u'/' + to, e.file, std::nullopt);
        besideIt = true;
        if (!done.failed && !done.written && !done.same) continue;  // that too: left be
      }
      if (done.failed) {
        result.failed++;
        qWarning("oldapp: %s could not be copied", qUtf8Printable(key));
        continue;
      }
      if (done.written) {
        count++;
        if (besideIt) result.beside++;
      }
      files.insert(key, QJsonObject{{QStringLiteral("src"), double(e.mtime)},
                                    {QStringLiteral("size"), double(e.size)},
                                    {QStringLiteral("dst"), double(done.mtime)},
                                    {QStringLiteral("to"), to}});
      keep();
    }
  }

  // The soundfonts' notes, keyed by file name: merged into the folder's index
  // (what is already there wins) when the earlier app's changed.
  const QString key = QStringLiteral("soundfonts/") + kIndex;
  const QJsonObject was = files.value(key).toObject();
  if (index && !cancel && (number(was, "src") != index->mtime || number(was, "size") != index->size)) {
    const QString destIndex = stores.value(QStringLiteral("soundfonts")) + u'/' + kIndex;
    const auto ours = readJson(index->file);
    const auto theirs = readJson(destIndex);
    if (ours && theirs) {  // never over an index that cannot be read
      QJsonObject merged = *theirs;
      for (auto it = ours->constBegin(); it != ours->constEnd(); ++it) {
        const QString to = files.value(QStringLiteral("soundfonts/") + it.key())
                               .toObject()
                               .value(QStringLiteral("to"))
                               .toString(oldAppPortableName(it.key()));
        if (!merged.contains(to)) merged.insert(to, it.value());
      }
      if (merged == *theirs || writeJson(destIndex, merged)) {
        files.insert(key, QJsonObject{{QStringLiteral("src"), double(index->mtime)},
                                      {QStringLiteral("size"), double(index->size)},
                                      {QStringLiteral("dst"), double(mtimeOf(destIndex))},
                                      {QStringLiteral("to"), kIndex}});
        keep();
      }
    }
  }
  return result;
}

}  // namespace microtone
