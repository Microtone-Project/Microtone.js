// The desktop shell around the web app: one browser profile, the main window
// and the docs window, and what a browser does for a page that a bare
// QWebEngineView does not — where links go (links.h), downloads becoming a
// Save dialog, and closing the window asking the page first.
#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QMainWindow>
#include <QPointer>
#include <QUrl>
#include <QWebEnginePage>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineView>

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
   *  AudioSystem talks to it instead of starting a worklet. `files` is the
   *  file store's description (FileStore::describe()), given to every page. */
  Shell(QUrl origin, const QByteArray &token, const QString &dataDir, const QString &nativeEngine = {},
        const QJsonObject &nativeStatus = {}, const QJsonObject &files = {}, QObject *parent = nullptr);
  ~Shell() override;

  QWebEngineProfile *profile() const { return profile_; }
  QUrl origin() const { return origin_; }

  void openMain(const QUrl &url);
  void openDocs(const QUrl &url);
  void focusMain();
  void openOutside(const QUrl &url);
  /** The main window agreed to close: the app goes with it. */
  void quit();

 private:
  void onDownload(QWebEngineDownloadRequest *request);

  QUrl origin_;
  QWebEngineProfile *profile_;
  QPointer<AppWindow> main_;
  QPointer<AppWindow> docs_;
};

}  // namespace microtone
