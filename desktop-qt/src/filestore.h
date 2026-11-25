// The desktop app's file store: the page's projects, soundfonts, keymaps and
// instrument packs as ordinary files in a folder of the user's own, where they
// can be seen, backed up and synced like any other —
//
//   ~/Microtone/Projects     the File view's projects, folders and all
//   ~/Microtone/Soundfonts   converted soundfonts (*.taud.sf2.gz), index.json
//   ~/Microtone/Keymaps      jam layouts (*.taudkey)
//   ~/Microtone/Instruments  exported instrument packs (*.tsii), index.json
//
// (Windows: %USERPROFILE%\Microtone) — and, private to the app, its autosave
// copies in <app data>/autosave. In a browser the same stores are OPFS
// directories (microtone-worker/src/storage/opfs-browser.js); the page
// reaches these through /api/files on the app's own server
// (src/storage/native-files.js), behind the server's per-launch token.
//
//   GET    /api/files/<store>?list                 {files: [{name, size, mtime}], folders: [path]}
//   GET    /api/files/<store>/<path>               the file
//   GET    /api/files/<store>/<path>?stat          {kind: "file"|"directory", size, mtime}
//   PUT    /api/files/<store>/<path>               write it (folders made on the way), atomically
//   DELETE /api/files/<store>/<path>[?recursive]   a file, or a folder (empty, or with everything)
//   POST   /api/files/<store>/<path>?mkdir         a folder, and any above it
//   POST   /api/files/<store>/<path>?moveTo=<path> rename or move, within the store
//   POST   /api/files/<store>[/<path>]?reveal      show it in the system's file manager
//   GET    /api/files/oldapp                       how the copy from the earlier app went:
//          {state: "running"|"done", found, kind, projects, soundfonts, keymaps, beside, failed, tell}
//   POST   /api/files/oldapp?told                  the person has been told (tell is false from now on)
//
// A path is names joined by "/", each percent-encoded. Nothing outside the
// store is reachable: "." and "..", separators inside a name and paths whose
// real location (symlinks followed) leaves it are refused. A name that is
// CREATED must also be one every system can hold — none of <>:"|?* or control
// characters, no trailing dot or space, no CON/PRN/AUX/NUL/COMn/LPTn — since
// the folder may be synced between them; existing files are read whatever
// they are called. Errors answer with a short text saying why.
//
// At every start it brings over what the earlier desktop app (the Tauri
// build) kept in its webview, in the background (src/oldapp.h: read only
// there; here a file is created, or replaces only a copy nobody has touched
// since, or goes beside as "name (from the old app)"). The page asks how it
// went and says so once (src/storage/carry-over.js).
//
// MICROTONE_FILES_ROOT=<dir> puts the user's folder elsewhere (tests).
#pragma once

#include <QHash>
#include <QJsonObject>
#include <QMutex>
#include <QString>

#include <atomic>
#include <thread>

class QHttpServerRequest;
class QHttpServerResponder;
class QUrl;

namespace microtone {

class FileStore {
 public:
  /** `dataDir`: the app's own data folder (the autosave copies go there). */
  explicit FileStore(const QString &dataDir);
  ~FileStore();  // stops a copy from the earlier app between two files
  FileStore(const FileStore &) = delete;
  FileStore &operator=(const FileStore &) = delete;

  /** Bring over what the earlier desktop app kept, on a thread of its own. */
  void startOldAppCopy();

  /** Is this request the store's (/api/files/…)? */
  static bool handles(const QUrl &url);
  void handle(const QHttpServerRequest &request, QHttpServerResponder &responder) const;

  /** For the page (window.__MICROTONE_NATIVE__.files): the API's base and
   *  each user-visible folder as the person would write it. */
  QJsonObject describe() const;

  /** A name the store will create (see above). */
  static bool portableName(const QString &name);

 private:
  void handleOldApp(const QHttpServerRequest &request, QHttpServerResponder &responder) const;

  QString root_;                    // ~/Microtone
  QHash<QString, QString> stores_;  // store name → its folder
  QString oldAppRecord_;            // <app data>/oldapp-copy.json

  std::thread oldAppThread_;
  std::atomic<bool> oldAppCancel_{false};
  mutable QMutex oldAppLock_;
  mutable QJsonObject oldAppStatus_;  // guarded by oldAppLock_
};

}  // namespace microtone
