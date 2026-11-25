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
//
// The move to the next desktop app (desktop-qt). From 5.0.6 on this build asks
// microtone.cc (tauri.conf.json's endpoint, `from=tauri`), not GitHub: the
// site answers "nothing new" until the switch is thrown there
// (microtone-worker/server/desktop-update.js `TAURI_MOVES`), and then hands
// over the new app's manifest, which this updater installs like any other
// (the same key signs both). An update from 5.1.0 on IS the new app, and:
//   - macOS before 13 is declined here: the new app needs 13 (Qt 6.11), and
//     the update would leave an app that does not open;
//   - Windows installs it BESIDE this one (another uninstall entry, another
//     folder), so this app is still there afterwards: `new_app` finds the new
//     one, and the glue then says so instead of offering the update again.

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
  /// The update is the next desktop app, not another version of this one.
  moves: bool,
  /// Why it cannot be installed here ("macos": the new app needs macOS 13);
  /// nothing is kept to download then.
  blocked: Option<&'static str>,
}

/// The first version that is the next desktop app (desktop-qt).
const NEW_APP_FROM: (u64, u64) = (5, 1);
/// The oldest macOS the new app opens on: desktop-qt's deployment target.
#[cfg(target_os = "macos")]
const NEW_APP_MACOS: u32 = 13;

fn is_new_app(version: &str) -> bool {
  let mut parts = version.split(['.', '-', '+']).map(|part| part.parse::<u64>().unwrap_or(0));
  let major = parts.next().unwrap_or(0);
  let minor = parts.next().unwrap_or(0);
  (major, minor) >= NEW_APP_FROM
}

/// Whether the next app cannot run on this system.
fn new_app_blocked() -> Option<&'static str> {
  #[cfg(target_os = "macos")]
  {
    // sw_vers asks the system itself, never the compatibility version (10.16)
    // an old SDK would be told.
    let major = std::process::Command::new("/usr/bin/sw_vers")
      .arg("-productVersion")
      .output()
      .ok()
      .and_then(|out| String::from_utf8(out.stdout).ok())
      .and_then(|text| text.trim().split('.').next()?.parse::<u32>().ok());
    // Not known: offered. The new app's own Info.plist still says 13.
    if major.is_some_and(|major| major < NEW_APP_MACOS) {
      return Some("macos");
    }
  }
  None
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
  let updater = match std::env::var("MICROTONE_UPDATE_URL") {
    // For tests: another manifest, e.g. the preview channel's
    // (…/api/desktop/update?channel=preview&from=tauri).
    Ok(url) if !url.is_empty() => {
      let url = tauri::Url::parse(&url).map_err(message)?;
      app.updater_builder().endpoints(vec![url]).map_err(message)?.build().map_err(message)?
    }
    _ => app.updater().map_err(message)?,
  };
  let mut update = updater.check().await.map_err(message)?;
  let info = update.as_ref().map(|update| {
    let moves = is_new_app(&update.version);
    UpdateInfo {
      version: update.version.clone(),
      current: update.current_version.clone(),
      moves,
      blocked: if moves { new_app_blocked() } else { None },
    }
  });
  if info.as_ref().is_some_and(|info| info.blocked.is_some()) {
    update = None;
  }
  *app.state::<UpdateState>().update.lock().unwrap() = update;
  Ok(info)
}

/// Windows: where the next desktop app is installed, if it is. Its installer
/// (desktop-qt/installer/microtone.nsi) registers it under its own uninstall
/// key; this app's own is "Microtone". Elsewhere the update replaces this app,
/// so there is never one beside it. → { current: this app's version }, or null.
#[tauri::command]
pub fn new_app(app: AppHandle) -> Option<OldApp> {
  new_app_exe().map(|_| OldApp { current: app.package_info().version.to_string() })
}

#[derive(Serialize)]
pub struct OldApp {
  current: String,
}

#[cfg(windows)]
fn new_app_exe() -> Option<std::path::PathBuf> {
  use winreg::RegKey;
  use winreg::enums::HKEY_CURRENT_USER;
  let key = RegKey::predef(HKEY_CURRENT_USER)
    .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\cc.microtone.desktop")
    .ok()?;
  let folder: String = key.get_value("InstallLocation").ok()?;
  let exe = std::path::Path::new(folder.trim_matches('"')).join("microtone.exe");
  exe.is_file().then_some(exe)
}

#[cfg(not(windows))]
fn new_app_exe() -> Option<std::path::PathBuf> {
  None
}

/// Start the next desktop app (Windows, where it sits beside this one).
#[tauri::command]
pub fn open_new_app() -> Result<(), String> {
  let exe = new_app_exe().ok_or("the new app is not installed")?;
  let mut command = std::process::Command::new(&exe);
  if let Some(folder) = exe.parent() {
    command.current_dir(folder);
  }
  command.spawn().map(|_| ()).map_err(message)
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

#[cfg(test)]
mod tests {
  use super::is_new_app;

  #[test]
  fn the_new_app_is_5_1_on() {
    for v in ["5.1.0", "5.1.1", "5.2.0", "6.0.0", "5.1.0-beta.1", "10.0.0"] {
      assert!(is_new_app(v), "{v}");
    }
    for v in ["5.0.6", "5.0.7", "5.0.10", "4.10.0", "0.0.0", ""] {
      assert!(!is_new_app(v), "{v}");
    }
  }
}
