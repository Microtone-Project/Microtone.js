// Downloads → a native Save dialog. The web app saves the way any page does:
// a blob URL and an <a download> click (src/storage/import-export.js). A
// browser then asks where the file goes, or drops it in Downloads and says so;
// a bare webview does neither dependably (WebKitGTK writes to ~/Downloads
// without a word, WKWebView before macOS 11.3 writes nothing). So the webview
// downloads into a private staging folder, and once every byte is there a
// Save dialog asks where the file goes; it is moved there, or deleted if the
// person cancels. Staging rather than asking first, because the destination
// has to be decided synchronously inside the webview's callback, and a dialog
// cannot be shown from there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager, Webview};

#[derive(Default)]
pub struct Downloads {
  next: AtomicU64,
  /// Staged file per download URL — macOS reports no path when a download
  /// finishes, so the path is remembered from when it started.
  staged: Mutex<HashMap<String, PathBuf>>,
  /// Where the person saved last; the next dialog opens there.
  last_dir: Mutex<Option<PathBuf>>,
}

fn staging_root(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_cache_dir().ok().map(|dir| dir.join("downloads"))
}

/// Leftovers of a run that ended between a download and its dialog.
pub fn clear_staging(app: &AppHandle) {
  if let Some(root) = staging_root(app) {
    let _ = std::fs::remove_dir_all(root);
  }
}

pub fn download_handler(app: AppHandle) -> impl Fn(Webview, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
  move |webview, event| {
    let downloads = app.state::<Downloads>();
    match event {
      DownloadEvent::Requested { url, destination } => {
        let name = suggested_name(destination);
        // One folder per download, so two exports of one name cannot collide.
        let n = downloads.next.fetch_add(1, Ordering::Relaxed);
        let Some(dir) = staging_root(&app).map(|root| root.join(n.to_string())) else {
          return false;
        };
        if let Err(err) = std::fs::create_dir_all(&dir) {
          notice(&webview, "saveFailed", &name, &err.to_string());
          return false;
        }
        let path = dir.join(&name);
        *destination = path.clone();
        downloads.staged.lock().unwrap().insert(url.to_string(), path);
        true
      }
      DownloadEvent::Finished { url, success, .. } => {
        let Some(staged) = downloads.staged.lock().unwrap().remove(url.as_str()) else {
          return true;
        };
        if success {
          ask_where(&app, webview, staged);
        } else {
          notice(&webview, "exportFailed", &file_name(&staged), "");
          discard(&staged);
        }
        true
      }
      _ => true,
    }
  }
}

/// The name the page gave the file. Every webview fills `destination` with
/// its Downloads folder plus that name — made unique with " (1)", " (2)"…
/// when Downloads already has one, which is no concern of a file that is not
/// going to Downloads.
fn suggested_name(destination: &Path) -> String {
  let name = file_name(destination);
  if let Some(original) = strip_uniquifier(&name)
    && destination.with_file_name(&original).exists()
  {
    return original;
  }
  if name.is_empty() { "download".to_string() } else { name }
}

/// "song (2).taud" → "song.taud"; None when there is no such suffix.
fn strip_uniquifier(name: &str) -> Option<String> {
  let (stem, ext) = match name.rfind('.') {
    Some(dot) if dot > 0 => name.split_at(dot),
    _ => (name, ""),
  };
  let open = stem.strip_suffix(')')?.rfind(" (")?;
  let digits = &stem[open + 2..stem.len() - 1];
  if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  Some(format!("{}{ext}", &stem[..open]))
}

fn file_name(path: &Path) -> String {
  path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn ask_where(app: &AppHandle, webview: Webview, staged: PathBuf) {
  let name = file_name(&staged);
  let start = app
    .state::<Downloads>()
    .last_dir
    .lock()
    .unwrap()
    .clone()
    .or_else(|| app.path().download_dir().ok());
  let app = app.clone();
  pick_destination(webview.window(), name, start, move |picked| {
    let Some(to) = picked else {
      discard(&staged);
      return;
    };
    // Off the main thread: a stem ZIP can be large, and the cache may be on
    // another file system than the destination.
    std::thread::spawn(move || match move_file(&staged, &to) {
      Ok(()) => *app.state::<Downloads>().last_dir.lock().unwrap() = to.parent().map(Path::to_path_buf),
      Err(err) => {
        notice(&webview, "saveFailed", &file_name(&to), &err.to_string());
        discard(&staged);
      }
    });
  });
}

/// The Save dialog. On Linux GTK's own, made on Tauri's GTK thread: rfd
/// would start a second thread iterating GTK's main context, which then
/// handles this app's window events too — after one dialog, closing the
/// window hid it without a CloseRequested.
#[cfg(target_os = "linux")]
fn pick_destination(
  window: tauri::Window,
  name: String,
  start: Option<PathBuf>,
  done: impl FnOnce(Option<PathBuf>) + Send + 'static,
) {
  let app = window.app_handle().clone();
  let _ = app.run_on_main_thread(move || {
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    let parent = window.gtk_window().ok();
    // Native: the desktop's own dialog through the portal, where there is one.
    // Titled with the file's name: no string to translate, and without a
    // title the window manager shows the program's name.
    let chooser =
      gtk::FileChooserNative::new(Some(&name), parent.as_ref(), gtk::FileChooserAction::Save, None, None);
    chooser.set_do_overwrite_confirmation(true);
    chooser.set_current_name(&name);
    if let Some(start) = start {
      chooser.set_current_folder(start);
    }
    // GTK does not keep a native dialog alive while it is shown; this does,
    // until it answers.
    let alive = Rc::new(RefCell::new(Some(chooser.clone())));
    let done = RefCell::new(Some(done));
    chooser.connect_response(move |chooser, response| {
      let picked = (response == gtk::ResponseType::Accept).then(|| chooser.filename()).flatten();
      if let Some(done) = done.borrow_mut().take() {
        done(picked);
      }
      alive.borrow_mut().take();
    });
    chooser.show();
  });
}

/// The Save dialog, through rfd: made on the main thread and awaited off it
/// (the same dance tauri-plugin-dialog does).
#[cfg(not(target_os = "linux"))]
fn pick_destination(
  window: tauri::Window,
  name: String,
  start: Option<PathBuf>,
  done: impl FnOnce(Option<PathBuf>) + Send + 'static,
) {
  let app = window.app_handle().clone();
  let _ = app.run_on_main_thread(move || {
    let mut dialog = rfd::AsyncFileDialog::new()
      .set_file_name(&name)
      .set_can_create_directories(true)
      .set_parent(&window);
    if let Some(start) = start {
      dialog = dialog.set_directory(start);
    }
    let picked = dialog.save_file();
    std::thread::spawn(move || {
      done(tauri::async_runtime::block_on(picked).map(|picked| picked.path().to_path_buf()));
    });
  });
}

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
  if std::fs::rename(from, to).is_err() {
    // Another file system than the cache's: copy, then let discard() tidy.
    std::fs::copy(from, to)?;
  }
  discard(from);
  Ok(())
}

/// The staged file and its one-download folder.
fn discard(staged: &Path) {
  let _ = std::fs::remove_file(staged);
  if let Some(dir) = staged.parent() {
    let _ = std::fs::remove_dir(dir);
  }
}

/// A line in the glue's banner, in the app's language.
fn notice(webview: &Webview, key: &str, name: &str, error: &str) {
  let params = serde_json::json!({ "name": name, "error": error });
  let _ = webview.eval(format!("window.__microtoneDesktop?.notice({}, {params})", serde_json::json!(key)));
}

#[cfg(test)]
mod tests {
  use super::strip_uniquifier;

  #[test]
  fn uniquifier() {
    assert_eq!(strip_uniquifier("song (1).taud").as_deref(), Some("song.taud"));
    assert_eq!(strip_uniquifier("song (12).wav").as_deref(), Some("song.wav"));
    assert_eq!(strip_uniquifier("stems.tar (3).gz").as_deref(), Some("stems.tar.gz"));
    assert_eq!(strip_uniquifier("README (2)").as_deref(), Some("README"));
    assert_eq!(strip_uniquifier("song.taud"), None);
    assert_eq!(strip_uniquifier("song (x).taud"), None);
    assert_eq!(strip_uniquifier("song ().taud"), None);
    assert_eq!(strip_uniquifier("(1).taud"), None);
  }
}
