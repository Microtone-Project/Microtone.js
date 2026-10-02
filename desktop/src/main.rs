// Microtone desktop: the web app in ../microtone-worker, served from inside the
// binary by Tauri 2. microtone-worker knows nothing about this shell — it is
// the same site microtone.cc serves — so everything a browser does for a page
// that a bare webview does not is done here, or in glue/desktop.js, which every
// page gets as an initialization script:
//
//   links.rs        target=_blank, docs.html, and links to the outside world
//   saving.rs       a download becomes a native Save dialog
//   closing.rs      closing the window asks the page's beforeunload first
//   updates.rs      the updater plugin, driven by the glue's banner
//   online.rs       online projects: browser sign-in, an access token, the API
//   mac_dialogs.rs  alert() and confirm() on macOS, where wry has neither
//   webkitgtk.rs    storage, the microphone: what WebKitGTK has switched off

// No console window next to the app on Windows (release builds).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod closing;
mod links;
#[cfg(target_os = "macos")]
mod mac_dialogs;
mod online;
mod saving;
mod updates;
#[cfg(target_os = "linux")]
mod webkitgtk;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// The app's window. Closing it quits.
pub const MAIN: &str = "main";
/// The manual and the patch notes (docs.html), beside the app.
pub const DOCS: &str = "docs";

const GLUE: &str = include_str!("../glue/desktop.js");

/// glue/desktop.js, preceded by the two facts it cannot find out for itself.
pub fn glue_script(window: &str) -> String {
  let platform = if cfg!(target_os = "macos") {
    "macos"
  } else if cfg!(windows) {
    "windows"
  } else {
    "linux"
  };
  format!("window.__MICROTONE_DESKTOP__ = {{ platform: \"{platform}\", window: \"{window}\" }};\n{GLUE}")
}

fn open_main(app: &AppHandle) -> tauri::Result<()> {
  let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::default())
    .title("Microtone")
    .inner_size(1440.0, 900.0)
    .min_inner_size(800.0, 560.0)
    .center()
    // Dropped files go to the page's own drop handler, as in a browser
    // (Tauri's handler would swallow them on Windows).
    .disable_drag_drop_handler()
    .initialization_script(glue_script(MAIN))
    .on_navigation(links::navigation_guard(app.clone(), MAIN))
    .on_new_window(links::new_window_guard(app.clone()))
    .on_download(saving::download_handler(app.clone()))
    // The sampler's Record. The OS still asks the person (macOS, Windows).
    .on_permission_request(|_, kind| match kind {
      PermissionKind::Microphone => PermissionResponse::Allow,
      _ => PermissionResponse::Default,
    })
    .build()?;
  #[cfg(target_os = "linux")]
  webkitgtk::configure(&window);
  #[cfg(not(target_os = "linux"))]
  let _ = window;
  Ok(())
}

fn main() {
  let builder = tauri::Builder::default()
    // First, so a second launch hands over before anything else starts: two
    // instances would share one browser profile, projects and all.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      links::focus_main(app);
    }))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    // links.rs decides where links go; the plugin's own click handler would
    // send the app's docs.html to the browser on Windows (http://tauri.localhost).
    .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(closing::CloseState::default())
    .manage(online::Online::default())
    .manage(saving::Downloads::default())
    .manage(updates::UpdateState::default())
    .invoke_handler(tauri::generate_handler![
      closing::close_ack,
      closing::close_confirmed,
      updates::update_check,
      updates::update_download,
      updates::update_install,
      online::online_request,
      online::online_sign_in,
    ])
    .setup(|app| {
      saving::clear_staging(app.handle());
      online::load(app.handle());
      // The browser's sign-in comes back as cc.microtone.desktop:/signed-in…
      let handle = app.handle().clone();
      app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
          online::deep_link(&handle, &url);
        }
      });
      // An installer registers the scheme (deb, rpm, NSIS, the .app); an
      // AppImage, or a build run from target/, has to do it itself.
      #[cfg(target_os = "linux")]
      let register = cfg!(debug_assertions) || app.env().appimage.is_some();
      #[cfg(windows)]
      let register = cfg!(debug_assertions);
      #[cfg(any(target_os = "linux", windows))]
      if register && let Err(err) = app.deep_link().register_all() {
        eprintln!("microtone: could not register cc.microtone.desktop: {err}");
      }
      open_main(app.handle())?;
      Ok(())
    });
  #[cfg(target_os = "macos")]
  let builder = builder.register_asynchronous_uri_scheme_protocol(mac_dialogs::SCHEME, mac_dialogs::answer);

  builder
    .build(tauri::generate_context!())
    .expect("Microtone could not start")
    .run(|app, event| match event {
      RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } if label == MAIN => {
        closing::on_close_requested(app, || api.prevent_close());
      }
      // Quit from the macOS app menu (Cmd+Q) or the OS: a code of None is a
      // request, not app.exit()'s own way out.
      RunEvent::ExitRequested { code: None, api, .. } if app.get_webview_window(MAIN).is_some() => {
        closing::on_close_requested(app, || api.prevent_exit());
      }
      _ => {}
    });
}
