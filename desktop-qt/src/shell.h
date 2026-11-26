// The desktop shell around the web app: one browser profile, the main window
// and the docs window, and what a browser does for a page that a bare
// QWebEngineView does not — where links go (links.h), downloads becoming a
// Save dialog, and closing the window asking the page first.
#pragma once

#include <QByteArray>
#include <QElapsedTimer>
#include <QJsonObject>
#include <QMainWindow>
#include <QPointer>
#include <QUrl>
#include <QWebEnginePage>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineView>

#include <functional>

class QWebEngineDownloadRequest;
class QWebEngineProfile;

namespace microtone {

class Shell;

enum class WindowRole { Main, Docs };

/** Adds the server's per-launch token to every request for the app's origin. */
class TokenInterceptor : public QWebEngineUrlRequestInterceptor {
 public:
  TokenInterceptor(QByteArray token, QObject *parent) : QWebEngineUrlRequestInterceptor(parent), token_(std::move(token)) {}
  void interceptRequest(QWebEngineUrlRequestInfo &info) override;

 private:
  QByteArray token_;
};

class AppPage : public QWebEnginePage {
  Q_OBJECT
 public:
  AppPage(QWebEngineProfile *profile, WindowRole role, Shell *shell, QObject *parent);

 protected:
  bool acceptNavigationRequest(const QUrl &url, NavigationType type, bool isMainFrame) override;
  /** `<input type=file>`: the desktop's Open dialog (through the portal on
   *  Linux, main.cpp), titled with what the page said it is for
   *  (Shell::announceDialog). Qt's own would have no title, and the portal's
   *  dialog then shows the portal's program name. */
  QStringList chooseFiles(FileSelectionMode mode, const QStringList &oldFiles,
                          const QStringList &acceptedMimeTypes) override;

 private:
  WindowRole role_;
  Shell *shell_;
};

/** The page's own context menus are the app's; this adds only the editing
 *  menu of a text field or a selection, never Back / Reload / View source. */
class AppView : public QWebEngineView {
  Q_OBJECT
 public:
  using QWebEngineView::QWebEngineView;

 protected:
  void contextMenuEvent(QContextMenuEvent *event) override;
};

class AppWindow : public QMainWindow {
  Q_OBJECT
 public:
  AppWindow(Shell *shell, WindowRole role);
  AppPage *page() const { return page_; }
  void bringToFront();

 protected:
  void closeEvent(QCloseEvent *event) override;

 private:
  void askThePage();

  Shell *shell_;
  WindowRole role_;
  AppView *view_;
  AppPage *page_;
  bool closeAgreed_ = false;
  bool awaitingAnswer_ = false;
};

class Shell : public QObject {
  Q_OBJECT
 public:
  /** `origin` is http://microtone.localhost/; the profile keeps its data in
   *  `dataDir`. `nativeEngine` (empty = none) is the native audio host's
   *  socket, given to every page with `nativeStatus`: the page's
   *  AudioSystem talks to it instead of starting a worklet. `services` go to
   *  every page as they are: `files` (FileStore::describe()) and `online`
   *  (Online::describe()). */
  Shell(QUrl origin, const QByteArray &token, const QString &dataDir, const QString &nativeEngine = {},
        const QJsonObject &nativeStatus = {}, const QJsonObject &services = {}, QObject *parent = nullptr);
  ~Shell() override;

  QWebEngineProfile *profile() const { return profile_; }
  QUrl origin() const { return origin_; }

  void openMain(const QUrl &url);
  void openDocs(const QUrl &url);
  void focusMain();
  void openOutside(const QUrl &url);
  /** A sign-in in the system's browser ended ("signed-in", "sign-in-failed"):
   *  the page hears it on the channel the website's sign-in window uses, and
   *  the main window comes forward. */
  void onlineAuth(const QString &type);
  /** The main window agreed to close: the app goes with it (after the
   *  farewell, when it has not been said). */
  void quit();

  /** What the page must finish before it goes: `hook(done)` is called as the
   *  farewell starts and calls `done` when that has happened (main.cpp: the
   *  control surface's last bytes reaching the device). */
  void setFarewell(std::function<void(std::function<void()>)> hook) { farewellHook_ = std::move(hook); }
  /** Let the main page say goodbye as a browser tab does when it closes —
   *  QtWebEngine tears a page down at quit without a `pagehide`, so the
   *  shell dispatches one — then `then()`. Said once; afterwards `then()` runs
   *  at once. */
  void sayFarewell(std::function<void()> then);

  /** The page is about to open a dialog (POST /api/desktop/dialog, from
   *  storage/import-export.js `withDialogTitle`): `kind` "open" (a file picker) or
   *  "save" (a download), its `title` ("" for the shell's own), and the
   *  page's language. */
  void announceDialog(const QString &kind, const QString &title, const QString &lang);
  /** The title of a dialog of `kind` opening now: what the page announced
   *  for it in the last ten seconds, taken once; otherwise Open or Save in
   *  the page's language. */
  QString takeDialogTitle(const QString &kind);

 private:
  void onDownload(QWebEngineDownloadRequest *request);

  QString dialogKind_, dialogTitle_;
  QElapsedTimer dialogAge_;

  QUrl origin_;
  QWebEngineProfile *profile_;
  QPointer<AppWindow> main_;
  QPointer<AppWindow> docs_;
  std::function<void(std::function<void()>)> farewellHook_;
  bool farewellSaid_ = false;
};

}  // namespace microtone
