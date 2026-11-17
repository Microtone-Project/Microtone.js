#include "shell.h"

#include <QApplication>
#include <QCloseEvent>
#include <QContextMenuEvent>
#include <QDesktopServices>
#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QJsonDocument>
#include <QMenu>
#include <QMessageBox>
#include <QPushButton>
#include <QScreen>
#include <QSettings>
#include <QStandardPaths>
#include <QTimer>
#include <QWebEngineContextMenuRequest>
#include <QWebEngineDownloadRequest>
#include <QWebEngineNewWindowRequest>
#include <QWebEnginePermission>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <QWebEngineUrlRequestInfo>

#include "appserver.h"
#include "links.h"

namespace microtone {

namespace {

// The shell's few words, in the app's two languages, chosen by the page's
// <html lang> (which the app's i18n sets) — as the Tauri glue does.
struct Words {
  const char *quitDirty, *discard, *cancel, *saveFailed;
};
const Words kEnglish = {"Quit and discard unsaved changes?", "Discard", "Cancel", "%1 could not be saved: %2"};
const Words kKorean = {"저장하지 않은 변경 사항을 버리고 끝낼까요?", "버리기", "취소", "%1을(를) 저장하지 못했습니다: %2"};
Words wordsFor(const QString &lang) { return lang.startsWith(u"ko") ? kKorean : kEnglish; }

// The app's own unsaved-changes test: its beforeunload handler cancels the
// event while the project is dirty (src/ui/app.js).
constexpr char kAskClose[] =
    "({ dirty: !window.dispatchEvent(new Event('beforeunload', { cancelable: true })),"
    "   lang: document.documentElement.lang })";

// The welcome screen's "Get the desktop app" is the website's offer of the
// very app this is.
constexpr char kGlue[] = R"JS((() => {
  const css = ".wc-desktop { display: none !important; }";
  const add = () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
  };
  if (document.documentElement) add();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } })
    .observe(document, { childList: true });
})();)JS";

QString pageLanguage(QWebEnginePage *page) {
  // Updated by the close question; good enough for the rarer dialogs.
  return page ? page->property("microtoneLang").toString() : QString();
}

}  // namespace

// ── TokenInterceptor ──

void TokenInterceptor::interceptRequest(QWebEngineUrlRequestInfo &info) {
  const QUrl url = info.requestUrl();
  if (url.scheme() == u"http" && url.host() == QLatin1String(kAppHost)) info.setHttpHeader(kTokenHeader, token_);
}

// ── AppPage ──

AppPage::AppPage(QWebEngineProfile *profile, WindowRole role, Shell *shell, QObject *parent)
    : QWebEnginePage(profile, parent), role_(role), shell_(shell) {
  // target=_blank and window.open: never a new bare window. Not opening the
  // request in a page refuses it.
  connect(this, &QWebEnginePage::newWindowRequested, this, [this](QWebEngineNewWindowRequest &request) {
    const QUrl url = request.requestedUrl();
    switch (classify(url)) {
      case Destination::Docs: shell_->openDocs(url); break;
      case Destination::App: shell_->focusMain(); break;
      case Destination::Outside: shell_->openOutside(url); break;
      case Destination::InPlace:
      case Destination::Nowhere: break;
    }
  });
  // The sampler's Record. The OS may still ask the person.
  connect(this, &QWebEnginePage::permissionRequested, this, [](QWebEnginePermission permission) {
    if (permission.permissionType() == QWebEnginePermission::PermissionType::MediaAudioCapture) permission.grant();
  });
}

bool AppPage::acceptNavigationRequest(const QUrl &url, NavigationType, bool isMainFrame) {
  if (!isMainFrame) return classify(url) != Destination::Nowhere;
  switch (classify(url)) {
    case Destination::Docs:
      if (role_ == WindowRole::Docs) return true;
      shell_->openDocs(url);
      return false;
    case Destination::App:
      if (role_ == WindowRole::Main) return true;
      // The docs' "Back to the app": back is the main window, and the docs
      // are done with, as the page they replaced would have been.
      QTimer::singleShot(0, shell_, [shell = shell_, view = QPointer<QWidget>(qobject_cast<QWidget *>(parent()))] {
        shell->focusMain();
        if (view) view->window()->close();
      });
      return false;
    case Destination::Outside:
      shell_->openOutside(url);
      return false;
    case Destination::InPlace: return true;
    case Destination::Nowhere: return false;
  }
  return false;
}

// ── AppView ──

void AppView::contextMenuEvent(QContextMenuEvent *event) {
  const QWebEngineContextMenuRequest *request = lastContextMenuRequest();
  if (!request || (!request->isContentEditable() && request->selectedText().isEmpty())) return;
  QMenu *menu = createStandardContextMenu();
  const QWebEnginePage::WebAction keep[] = {
      QWebEnginePage::Undo, QWebEnginePage::Redo, QWebEnginePage::Cut,
      QWebEnginePage::Copy, QWebEnginePage::Paste, QWebEnginePage::PasteAndMatchStyle,
      QWebEnginePage::SelectAll};
  for (QAction *action : menu->actions()) {
    bool editing = action->isSeparator();
    for (auto a : keep) editing = editing || action == pageAction(a);
    if (!editing) menu->removeAction(action);
  }
  menu->setAttribute(Qt::WA_DeleteOnClose);
  menu->popup(event->globalPos());
}

// ── AppWindow ──

AppWindow::AppWindow(Shell *shell, WindowRole role) : shell_(shell), role_(role) {
  setAttribute(Qt::WA_DeleteOnClose);
  view_ = new AppView(this);
  page_ = new AppPage(shell->profile(), role, shell, view_);
  view_->setPage(page_);
  setCentralWidget(view_);
  setWindowTitle(QStringLiteral("Microtone"));

  QSettings settings;
  const QString key = role == WindowRole::Main ? QStringLiteral("window/main") : QStringLiteral("window/docs");
  if (!restoreGeometry(settings.value(key).toByteArray())) {
    const QSize size = role == WindowRole::Main ? QSize(1440, 900) : QSize(1100, 820);
    const QRect screen = QApplication::primaryScreen()->availableGeometry();
    resize(size.boundedTo(screen.size()));
    move(screen.center() - rect().center());
  }
  if (role == WindowRole::Main) {
    setMinimumSize(800, 560);
  } else {
    connect(page_, &QWebEnginePage::titleChanged, this, &QWidget::setWindowTitle);
  }
  // The page closed itself (window.close()), or agreed to after RequestClose.
  connect(page_, &QWebEnginePage::windowCloseRequested, this, [this] {
    closeAgreed_ = true;
    close();
  });
}

void AppWindow::bringToFront() {
  if (isMinimized()) showNormal();
  show();
  raise();
  activateWindow();
}

void AppWindow::closeEvent(QCloseEvent *event) {
  if (role_ == WindowRole::Main && !closeAgreed_) {
    event->ignore();
    askThePage();
    return;
  }
  QSettings().setValue(role_ == WindowRole::Main ? QStringLiteral("window/main") : QStringLiteral("window/docs"),
                       saveGeometry());
  event->accept();
  if (role_ == WindowRole::Main) shell_->quit();
}

// Closing the main window: the page decides, as a browser tab's beforeunload
// lets it. A page that never answers must not make the window unclosable:
// when the previous question is still unanswered (a hung page), this close
// goes through.
void AppWindow::askThePage() {
  if (awaitingAnswer_) {
    closeAgreed_ = true;
    close();
    return;
  }
  awaitingAnswer_ = true;
  QPointer<AppWindow> self(this);
  page_->runJavaScript(QString::fromLatin1(kAskClose), [self](const QVariant &answer) {
    if (!self) return;
    self->awaitingAnswer_ = false;
    const QVariantMap map = answer.toMap();
    const QString lang = map.value(QStringLiteral("lang")).toString();
    self->page_->setProperty("microtoneLang", lang);
    if (map.value(QStringLiteral("dirty")).toBool()) {
      const Words w = wordsFor(lang);
      QMessageBox box(QMessageBox::Warning, QStringLiteral("Microtone"), QString::fromUtf8(w.quitDirty),
                      QMessageBox::NoButton, self);
      QPushButton *discard = box.addButton(QString::fromUtf8(w.discard), QMessageBox::DestructiveRole);
      box.setDefaultButton(box.addButton(QString::fromUtf8(w.cancel), QMessageBox::RejectRole));
      box.exec();
      if (!self || box.clickedButton() != discard) return;
    }
    self->closeAgreed_ = true;
    self->close();
  });
}

// ── Shell ──

Shell::Shell(QUrl origin, const QByteArray &token, const QString &dataDir, const QString &nativeEngine,
             const QJsonObject &nativeStatus, QObject *parent)
    : QObject(parent), origin_(std::move(origin)) {
  profile_ = new QWebEngineProfile(QStringLiteral("microtone"), this);
  profile_->setPersistentStoragePath(dataDir + QStringLiteral("/webengine"));
  profile_->setCachePath(QStandardPaths::writableLocation(QStandardPaths::CacheLocation) + QStringLiteral("/webengine"));
  profile_->setUrlRequestInterceptor(new TokenInterceptor(token, this));
  profile_->setHttpCacheType(QWebEngineProfile::NoCache);

  QWebEngineSettings *s = profile_->settings();
  s->setAttribute(QWebEngineSettings::PlaybackRequiresUserGesture, false);
  s->setAttribute(QWebEngineSettings::FocusOnNavigationEnabled, true);

  QWebEngineScript glue;
  glue.setName(QStringLiteral("microtone-glue"));
  glue.setSourceCode(QString::fromUtf8(kGlue));
  glue.setInjectionPoint(QWebEngineScript::DocumentCreation);
  glue.setWorldId(QWebEngineScript::ApplicationWorld);
  glue.setRunsOnSubFrames(false);
  profile_->scripts()->insert(glue);

  // The native audio host, where there is one: the page's own world must see
  // it (core/audio/audio-system.js reads it), before any of its scripts run.
  if (!nativeEngine.isEmpty()) {
    QJsonObject native = nativeStatus;
    native.insert(QStringLiteral("engine"), nativeEngine);
    QWebEngineScript script;
    script.setName(QStringLiteral("microtone-native"));
    script.setSourceCode(QStringLiteral("window.__MICROTONE_NATIVE__ = Object.freeze(%1);")
                             .arg(QString::fromUtf8(QJsonDocument(native).toJson(QJsonDocument::Compact))));
    script.setInjectionPoint(QWebEngineScript::DocumentCreation);
    script.setWorldId(QWebEngineScript::MainWorld);
    script.setRunsOnSubFrames(false);
    profile_->scripts()->insert(script);
  }

  connect(profile_, &QWebEngineProfile::downloadRequested, this, &Shell::onDownload);
}

Shell::~Shell() {
  // Pages before their profile, or the profile outlives its own shutdown.
  delete docs_.data();
  delete main_.data();
}

void Shell::openMain(const QUrl &url) {
  if (!main_) main_ = new AppWindow(this, WindowRole::Main);
  main_->page()->load(url);
  main_->bringToFront();
}

void Shell::openDocs(const QUrl &url) {
  // Not from inside the page's own callback that asked.
  QTimer::singleShot(0, this, [this, url] {
    if (!docs_) docs_ = new AppWindow(this, WindowRole::Docs);
    docs_->page()->load(url);
    docs_->bringToFront();
  });
}

void Shell::focusMain() {
  if (main_) main_->bringToFront();
}

void Shell::openOutside(const QUrl &url) {
  if (!QDesktopServices::openUrl(url)) qWarning("microtone: could not open %s", qUtf8Printable(url.toString()));
}

void Shell::quit() {
  if (docs_) docs_->close();
  QTimer::singleShot(0, qApp, &QApplication::quit);
}

// Downloads → a native Save dialog. The web app saves the way any page does
// (a blob URL and an <a download> click); a browser would ask where the file
// goes, and so does this.
void Shell::onDownload(QWebEngineDownloadRequest *request) {
  QSettings settings;
  QString dir = settings.value(QStringLiteral("downloads/lastDir")).toString();
  if (dir.isEmpty() || !QDir(dir).exists())
    dir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
  QWidget *parent = main_ ? static_cast<QWidget *>(main_.data()) : nullptr;
  const QString path = QFileDialog::getSaveFileName(parent, QString(), dir + u'/' + request->suggestedFileName());
  if (path.isEmpty()) {
    request->cancel();
    return;
  }
  const QFileInfo info(path);
  settings.setValue(QStringLiteral("downloads/lastDir"), info.absolutePath());
  request->setDownloadDirectory(info.absolutePath());
  request->setDownloadFileName(info.fileName());
  connect(request, &QWebEngineDownloadRequest::stateChanged, this, [this, request](QWebEngineDownloadRequest::DownloadState state) {
    if (state != QWebEngineDownloadRequest::DownloadInterrupted) return;
    const Words w = wordsFor(pageLanguage(main_ ? main_->page() : nullptr));
    QMessageBox::warning(main_, QStringLiteral("Microtone"),
                         QString::fromUtf8(w.saveFailed).arg(request->downloadFileName(), request->interruptReasonString()));
  });
  request->accept();
}

}  // namespace microtone
