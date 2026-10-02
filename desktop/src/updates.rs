// Updates. The version is microtone-worker/package.json's: tauri.conf.json
// reads it into every build, and .github/workflows/desktop.yml publishes a
// GitHub release (with the updater's latest.json) for each version that has
// none yet — so bumping that version is what ships an update.
//
// The glue's banner drives it (glue/desktop.js): it asks update_check a few
// seconds after start-up, and nothing is downloaded until the person says
// Download. Then either "Restart now" (after the page's unsaved-changes check)
// or "When I quit", which closing.rs honours on the way out — an update never
// takes the window away from someone in the middle of a song.

use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
  update: Mutex<Option<Update>>,
  bytes: Mutex<Option<Vec<u8>>>,
  install_on_quit: AtomicBool,
}

#[derive(Serialize)]
pub struct UpdateInfo {
  version: String,
  current: String,
}

fn message(err: impl Display) -> String {
  err.to_string()
}

/// Only an installed bundle updates itself: not a debug build, and not a bare
/// binary out of target/ (it would be overwritten with an AppImage).
fn updatable() -> bool {
  !cfg!(debug_assertions) && tauri::utils::platform::bundle_type().is_some()
}

/// → the newer version, or null. Fails when the release server cannot be
/// reached — the glue says nothing about that: offline is a normal state.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
  if !updatable() {
    return Ok(None);
  }
  let update = app.updater().map_err(message)?.check().await.map_err(message)?;
  let info = update.as_ref().map(|update| UpdateInfo {
    version: update.version.clone(),
    current: update.current_version.clone(),
  });
  *app.state::<UpdateState>().update.lock().unwrap() = update;
  Ok(info)
}

/// Download (and verify) the update update_check found. Progress goes to the
/// glue's banner as whole percents.
#[tauri::command]
pub async fn update_download(app: AppHandle, webview: Webview) -> Result<(), String> {
  let state = app.state::<UpdateState>();
  let update = state.update.lock().unwrap().clone().ok_or("no update to download")?;
  let mut received = 0u64;
  let mut shown = None;
  let bytes = update
    .download(
      |chunk, total| {
        received += chunk as u64;
        let Some(total) = total.filter(|&total| total > 0) else { return };
        let percent = (received * 100 / total).min(100);
        if shown != Some(percent) {
          shown = Some(percent);
          let _ = webview.eval(format!("window.__microtoneDesktop?.updateProgress({percent})"));
        }
      },
      || {},
    )
    .await
    .map_err(message)?;
  *state.bytes.lock().unwrap() = Some(bytes);
  Ok(())
}

/// `restart`: install now and start the new version (the glue has already
/// run the page's unsaved-changes check). Otherwise install when Microtone
/// quits. Returns only if the install failed.
#[tauri::command]
pub fn update_install(app: AppHandle, restart: bool) -> Result<(), String> {
  if !restart {
    app.state::<UpdateState>().install_on_quit.store(true, Ordering::SeqCst);
    return Ok(());
  }
  // On Windows install() hands over to the installer, which starts the new
  // version itself, and exits this process. A sync command runs on the main
  // thread, where restart() goes straight out without an ExitRequested — so
  // no unsaved-changes check on the way (the glue asked already).
  install(&app, true)?;
  app.restart();
}

/// The update the person put off until now (closing.rs, on the way out).
pub fn install_deferred(app: &AppHandle) {
  if app.state::<UpdateState>().install_on_quit.load(Ordering::SeqCst)
    && let Err(err) = install(app, false)
  {
    eprintln!("microtone: the update could not be installed: {err}");
  }
}

fn install(app: &AppHandle, relaunch: bool) -> Result<(), String> {
  let state = app.state::<UpdateState>();
  let update = state.update.lock().unwrap().take().ok_or("no update to install")?;
  let bytes = state.bytes.lock().unwrap().take().ok_or("the update is not downloaded")?;
  update.restart_after_install(relaunch).install(bytes).map_err(message)
}
