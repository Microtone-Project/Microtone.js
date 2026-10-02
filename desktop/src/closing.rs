// Closing the main window: the page decides, as a browser tab's beforeunload
// lets it. A webview never runs beforeunload on its own way out, so the close
// is held, the glue dispatches one (window.__microtoneDesktop.requestClose),
// and the app's own handler — the one that guards an unsaved project in a
// browser — answers it. Clean, or dirty and the person says discard →
// close_confirmed, and the app quits (installing a deferred update first).
//
// A page that never answers must not make the window unclosable: when the
// previous request was never even acknowledged (a hung or broken page), the
// next close goes through.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

use crate::{updates, MAIN};

#[derive(Default)]
pub struct CloseState {
  /// A request is with the page and the glue has not said it got it.
  awaiting_ack: AtomicBool,
  /// The page (or the person) has said yes: nothing may hold the quit now.
  confirmed: AtomicBool,
}

/// A close or quit was requested. `hold` stops it; it is called unless the
/// quit is already agreed.
pub fn on_close_requested(app: &AppHandle, hold: impl FnOnce()) {
  let state = app.state::<CloseState>();
  if state.confirmed.load(Ordering::SeqCst) {
    return;
  }
  hold();
  if state.awaiting_ack.swap(true, Ordering::SeqCst) {
    // The last request went unanswered: the page cannot ask, so do not wait.
    quit(app);
    return;
  }
  let asked = app
    .get_webview_window(MAIN)
    .map(|main| main.eval("window.__microtoneDesktop?.requestClose()").is_ok())
    .unwrap_or(false);
  if !asked {
    quit(app);
  }
}

/// The glue has the request (it may now be asking the person).
#[tauri::command]
pub fn close_ack(state: tauri::State<'_, CloseState>) {
  state.awaiting_ack.store(false, Ordering::SeqCst);
}

/// Nothing unsaved, or the person agreed to lose it.
#[tauri::command]
pub fn close_confirmed(app: AppHandle) {
  quit(&app);
}

fn quit(app: &AppHandle) {
  app.state::<CloseState>().confirmed.store(true, Ordering::SeqCst);
  updates::install_deferred(app);
  app.exit(0);
}
