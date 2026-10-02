// Where a link goes. In a browser the app is a tab: target=_blank opens
// another tab, and Back comes home. A desktop window has neither, so
//
//   docs.html (the manual, the patch notes)  → the "docs" window
//   any other page of the app                → the main window
//   http(s) and mailto                       → the system's browser
//
// and the window the link was clicked in stays on its page. That last part is
// what matters: the main window must never navigate away from an open project.

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::{glue_script, DOCS, MAIN};

#[derive(Debug, PartialEq)]
enum Destination {
  Docs,
  App,
  Outside,
  /// Not a page: blob:, data:, about:blank. Left alone.
  InPlace,
  Nowhere,
}

/// Is this the app's own origin? tauri://localhost on Linux and macOS,
/// http://tauri.localhost on Windows, and in a debug build the CLI's dev server
/// (`cargo tauri dev`) — in a release a localhost link is some other server.
fn is_app(url: &Url) -> bool {
  match url.scheme() {
    "tauri" => true,
    "http" | "https" => {
      let host = url.host_str();
      host == Some("tauri.localhost")
        || (cfg!(debug_assertions) && matches!(host, Some("localhost" | "127.0.0.1")))
    }
    _ => false,
  }
}

fn classify(url: &Url) -> Destination {
  if is_app(url) {
    return if url.path() == "/docs.html" { Destination::Docs } else { Destination::App };
  }
  match url.scheme() {
    "http" | "https" | "mailto" => Destination::Outside,
    "blob" | "data" | "about" => Destination::InPlace,
    _ => Destination::Nowhere,
  }
}

/// `on_navigation` for a window labelled `window`: true lets it navigate.
pub fn navigation_guard(app: AppHandle, window: &'static str) -> impl Fn(&Url) -> bool + Send + 'static {
  move |url| match classify(url) {
    Destination::Docs if window == DOCS => true,
    Destination::Docs => {
      open_docs(&app, url.clone());
      false
    }
    Destination::App if window == MAIN => true,
    Destination::App => {
      // The docs' "Back to the app": back is the main window, and the docs
      // are done with, as the page they replaced would have been. Closed
      // after this callback returns, not from inside it.
      let app = app.clone();
      tauri::async_runtime::spawn(async move {
        focus_main(&app);
        if let Some(here) = app.get_webview_window(window) {
          let _ = here.close();
        }
      });
      false
    }
    Destination::Outside => {
      open_outside(&app, url);
      false
    }
    Destination::InPlace => true,
    Destination::Nowhere => false,
  }
}

/// `on_new_window` (target=_blank, window.open): never a new bare window.
pub fn new_window_guard(app: AppHandle) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<Wry> + Send + 'static {
  move |url, _features| {
    match classify(&url) {
      Destination::Docs => open_docs(&app, url),
      Destination::App => focus_main(&app),
      Destination::Outside => open_outside(&app, &url),
      Destination::InPlace | Destination::Nowhere => {}
    }
    NewWindowResponse::Deny
  }
}

pub fn focus_main(app: &AppHandle) {
  if let Some(main) = app.get_webview_window(MAIN) {
    let _ = main.unminimize();
    let _ = main.set_focus();
  }
}

/// Open `url` (docs.html, perhaps with a #section) in the docs window, making
/// it if need be.
fn open_docs(app: &AppHandle, url: Url) {
  let app = app.clone();
  // Not from inside the webview callback that asked: building a window there
  // deadlocks WebView2.
  tauri::async_runtime::spawn(async move {
    if let Some(docs) = app.get_webview_window(DOCS) {
      let _ = docs.navigate(url);
      let _ = docs.unminimize();
      let _ = docs.set_focus();
      return;
    }
    let built = WebviewWindowBuilder::new(&app, DOCS, WebviewUrl::External(url))
      .title("Microtone")
      .inner_size(1100.0, 820.0)
      .initialization_script(glue_script(DOCS))
      .on_navigation(navigation_guard(app.clone(), DOCS))
      .on_new_window(new_window_guard(app.clone()))
      .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
      })
      .build();
    if let Err(err) = built {
      eprintln!("microtone: could not open the docs window: {err}");
    }
  });
}

fn open_outside(app: &AppHandle, url: &Url) {
  if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
    eprintln!("microtone: could not open {url}: {err}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn at(s: &str) -> Destination {
    classify(&Url::parse(s).unwrap())
  }

  #[test]
  fn the_apps_own_pages_on_every_platform() {
    assert_eq!(at("tauri://localhost/docs.html#patchnotes"), Destination::Docs);
    assert_eq!(at("http://tauri.localhost/docs.html"), Destination::Docs);
    assert_eq!(at("http://localhost:1430/docs.html"), Destination::Docs);
    assert_eq!(at("tauri://localhost/index.html"), Destination::App);
    assert_eq!(at("tauri://localhost/"), Destination::App);
    assert_eq!(at("http://tauri.localhost/player.html?tracker=1"), Destination::App);
  }

  #[test]
  fn everything_else() {
    assert_eq!(at("https://github.com/curioustorvald/Microtone.js"), Destination::Outside);
    assert_eq!(at("https://microtone.cc/docs.html"), Destination::Outside);
    assert_eq!(at("mailto:someone@example.com"), Destination::Outside);
    assert_eq!(at("blob:tauri://localhost/2b9c-…"), Destination::InPlace);
    assert_eq!(at("about:blank"), Destination::InPlace);
    assert_eq!(at("file:///etc/passwd"), Destination::Nowhere);
    assert_eq!(at("javascript:alert(1)"), Destination::Nowhere);
  }
}
