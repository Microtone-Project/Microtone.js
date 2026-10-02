// alert() and confirm() on macOS. wry's WKUIDelegate implements neither, so in
// a bare WKWebView alert() does nothing and confirm() answers false at once —
// and the app asks with confirm() before every destructive step. The glue
// replaces both with a SYNCHRONOUS XMLHttpRequest to this scheme (the one way
// a page can block on the native side), which is answered once the person has
// answered a native alert. Linux (WebKitGTK) and Windows (WebView2) draw these
// dialogs themselves, so this exists on macOS only.
//
// mtdialog://localhost/alert or /confirm, the message as the POST body;
// answers "1" (OK) or "0".

use tauri::http::{Request, Response};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

pub const SCHEME: &str = "mtdialog";

pub fn answer(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
  let confirm = request.uri().path() == "/confirm";
  let message = String::from_utf8_lossy(request.body()).into_owned();
  let app = ctx.app_handle().clone();
  let window = app.get_webview_window(ctx.webview_label());
  // Made on the main thread, awaited off it, as rfd wants.
  let _ = app.run_on_main_thread(move || {
    let mut dialog = rfd::AsyncMessageDialog::new()
      .set_title("Microtone")
      .set_description(message)
      .set_level(rfd::MessageLevel::Info)
      .set_buttons(if confirm { rfd::MessageButtons::OkCancel } else { rfd::MessageButtons::Ok });
    if let Some(window) = &window {
      dialog = dialog.set_parent(window);
    }
    let shown = dialog.show();
    std::thread::spawn(move || {
      let ok = matches!(
        tauri::async_runtime::block_on(shown),
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes
      );
      responder.respond(
        Response::builder()
          // The page is tauri://localhost; this scheme is another origin.
          .header("Access-Control-Allow-Origin", "*")
          .header("Content-Type", "text/plain")
          .body(if ok { b"1".to_vec() } else { b"0".to_vec() })
          .unwrap(),
      );
    });
  });
}
