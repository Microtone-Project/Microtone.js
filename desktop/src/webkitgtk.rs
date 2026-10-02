// WebKitGTK, set up as Microtone needs it. wry leaves three things at
// WebKitGTK's defaults that a browser would have on:
//
//   - the Storage API and the File System API (navigator.storage and the
//     origin-private file system, src/storage/opfs.js) — where the app keeps
//     every project, so without them nothing persists from one run to the next
//   - MediaStream (getUserMedia) — the sampler's Record
//   - debug builds only: the page's console goes to stdout
//
// The feature switches (WebKitFeature) arrived in WebKitGTK 2.42, after the
// webkit2gtk crate's newest bindings, so they are looked up at run time: on an
// older WebKitGTK the app still starts, and says itself that nothing persists.

use std::ffi::{c_char, c_int, c_void, CStr};

use webkit2gtk::glib::object::ObjectType;
use webkit2gtk::{SettingsExt, WebViewExt};

/// WebKit's identifiers: navigator.storage, getDirectory(), createWritable(),
/// and createSyncAccessHandle() (opfs.js's fallback when createWritable is missing).
const FEATURES: [&str; 4] = ["StorageAPI", "FileSystem", "FileSystemWritableStream", "AccessHandle"];

pub fn configure(window: &tauri::WebviewWindow) {
  let _ = window.with_webview(|webview| {
    let Some(settings) = webview.inner().settings() else { return };
    settings.set_enable_media_stream(true);
    settings.set_enable_write_console_messages_to_stdout(cfg!(debug_assertions));
    enable_features(settings.as_ptr().cast());
    // This runs once the webview exists, so its first load has begun, and
    // WebKit decides whether navigator.storage exists when a page is made.
    // Start that load again under the new settings.
    webview.inner().reload();
  });
}

unsafe extern "C" {
  fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

fn enable_features(settings: *mut c_void) {
  type GetAll = unsafe extern "C" fn() -> *mut c_void;
  type Length = unsafe extern "C" fn(*mut c_void) -> usize;
  type Get = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
  type Identifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
  type SetEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int);
  type Unref = unsafe extern "C" fn(*mut c_void);

  // RTLD_DEFAULT: the libwebkit2gtk-4.1 this process already loaded.
  let find = |name: &CStr| unsafe { dlsym(std::ptr::null_mut(), name.as_ptr()) };
  let symbols = [
    find(c"webkit_settings_get_all_features"),
    find(c"webkit_feature_list_get_length"),
    find(c"webkit_feature_list_get"),
    find(c"webkit_feature_get_identifier"),
    find(c"webkit_settings_set_feature_enabled"),
    find(c"webkit_feature_list_unref"),
  ];
  if symbols.iter().any(|symbol| symbol.is_null()) {
    eprintln!("microtone: WebKitGTK is older than 2.42 — no origin-private file system, so projects will not persist");
    return;
  }
  // SAFETY: each symbol is the WebKitGTK function of that name, and these are
  // their C signatures (webkit/WebKitFeature.h, webkit/WebKitSettings.h).
  unsafe {
    let get_all: GetAll = std::mem::transmute(symbols[0]);
    let length: Length = std::mem::transmute(symbols[1]);
    let get: Get = std::mem::transmute(symbols[2]);
    let identifier: Identifier = std::mem::transmute(symbols[3]);
    let set_enabled: SetEnabled = std::mem::transmute(symbols[4]);
    let unref: Unref = std::mem::transmute(symbols[5]);

    let list = get_all();
    for index in 0..length(list) {
      let feature = get(list, index);
      let id = CStr::from_ptr(identifier(feature)).to_bytes();
      if FEATURES.iter().any(|wanted| wanted.as_bytes() == id) {
        set_enabled(settings, feature, 1);
      }
    }
    unref(list);
  }
}
