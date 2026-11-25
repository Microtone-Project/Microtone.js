//! Moving the projects to the next desktop app (desktop-qt, item 336).
//!
//! This build keeps every project in its webview's OPFS, in a form only that
//! webview reads (WebView2's LevelDB, WebKit's own). The Qt build keeps them as
//! ordinary files in ~/Microtone (%USERPROFILE%\Microtone on Windows):
//!
//!   Projects/    the File view's projects, folders and all
//!   Soundfonts/  converted soundfonts (*.taud.sf2.gz) and index.json
//!   Keymaps/     jam layouts (*.taudkey)
//!
//! (desktop-qt/src/filestore.cpp). So this build copies its own: the glue
//! reads OPFS through the page's API and hands each file here, which writes it
//! into that folder. Nothing is deleted anywhere.
//!
//! It never overwrites what it did not write. `handover_write` creates a file,
//! or replaces one only while it is still exactly what this wrote (the glue
//! passes back the modification time it was given); a file already there with
//! the same bytes counts as written. Anything else is answered "not written",
//! and the glue puts its copy beside it.
//!
//! MICROTONE_FILES_ROOT=<dir> puts the folder elsewhere (tests), as for the Qt
//! build.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

const STORES: &[(&str, &str)] = &[("projects", "Projects"), ("soundfonts", "Soundfonts"), ("keymaps", "Keymaps")];

fn root(app: &AppHandle) -> Result<PathBuf, String> {
  if let Some(dir) = std::env::var_os("MICROTONE_FILES_ROOT").filter(|d| !d.is_empty()) {
    return Ok(PathBuf::from(dir));
  }
  let home = app.path().home_dir().map_err(|e| e.to_string())?;
  Ok(home.join("Microtone"))
}

fn store_dir(root: &Path, store: &str) -> Result<PathBuf, String> {
  STORES.iter().find(|(id, _)| *id == store).map(|(_, dir)| root.join(dir)).ok_or_else(|| format!("no store {store}"))
}

/// A name every system can hold (the folder may be synced between them): the
/// Qt build's FileStore::portableName, rule for rule.
pub fn portable(name: &str) -> bool {
  if name.is_empty() || name == "." || name == ".." || name.chars().count() > 200 || name.trim() != name {
    return false;
  }
  if name.ends_with('.') || name.ends_with(' ') {
    return false;
  }
  if name.chars().any(|c| (c as u32) < 0x20 || "/\\<>:\"|?*".contains(c)) {
    return false;
  }
  let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
  let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
    || ((stem.starts_with("com") || stem.starts_with("lpt"))
      && stem.len() == 4
      && stem.as_bytes()[3].is_ascii_digit()
      && stem.as_bytes()[3] != b'0');
  !reserved
}

/// "%41b%20c" → "Ab c" (the glue encodes a path so a header can carry it).
pub fn percent_decode(text: &str) -> Result<String, String> {
  let bytes = text.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' {
      let hex = text.get(i + 1..i + 3).ok_or("a broken escape")?;
      out.push(u8::from_str_radix(hex, 16).map_err(|_| "a broken escape")?);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).map_err(|_| "not UTF-8".to_string())
}

/// The file for a store-relative path, every name in it portable.
fn target(root: &Path, store: &str, path: &str) -> Result<PathBuf, String> {
  let mut at = store_dir(root, store)?;
  let mut any = false;
  for name in path.split('/') {
    if !portable(name) {
      return Err(format!("not a name every system can hold: {name:?}"));
    }
    at.push(name);
    any = true;
  }
  if !any {
    return Err("no path".into());
  }
  Ok(at)
}

fn mtime_ms(path: &Path) -> u64 {
  fs::metadata(path)
    .and_then(|m| m.modified())
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// What `write` did: written (created or replaced), or found the same bytes
/// there; either way the file's modification time now.
#[derive(Debug, PartialEq)]
pub struct Written {
  pub written: bool,
  pub same: bool,
  pub mtime: u64,
}

/// Create `file`, or replace it when `replace` is the modification time it
/// still has ("*": whatever it has). Written whole beside it, then renamed in.
pub fn write(file: &Path, bytes: &[u8], replace: Option<&str>) -> Result<Written, String> {
  if file.is_dir() {
    return Err("a folder is there".into());
  }
  if file.exists() {
    let now = mtime_ms(file);
    if fs::read(file).map(|old| old == bytes).unwrap_or(false) {
      return Ok(Written { written: false, same: true, mtime: now });
    }
    let ours = match replace {
      Some("*") => true,
      Some(t) => t.parse::<u64>().map(|t| t == now).unwrap_or(false),
      None => false,
    };
    if !ours {
      return Ok(Written { written: false, same: false, mtime: now });
    }
  }
  let parent = file.parent().ok_or("no folder")?;
  fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  let part = parent.join(format!(".{}.part-{}", file.file_name().and_then(|n| n.to_str()).unwrap_or("file"), std::process::id()));
  {
    let mut out = fs::File::create(&part).map_err(|e| e.to_string())?;
    out.write_all(bytes).map_err(|e| e.to_string())?;
    out.sync_all().map_err(|e| e.to_string())?;
  }
  fs::rename(&part, file).map_err(|e| {
    let _ = fs::remove_file(&part);
    e.to_string()
  })?;
  Ok(Written { written: true, same: false, mtime: mtime_ms(file) })
}

/// Where the folders are, as the person would write them.
#[tauri::command]
pub fn handover_info(app: AppHandle) -> Result<Value, String> {
  let root = root(&app)?;
  let shown = |p: PathBuf| p.to_string_lossy().into_owned();
  Ok(json!({
    "root": shown(root.clone()),
    "projects": shown(root.join("Projects")),
    "soundfonts": shown(root.join("Soundfonts")),
    "keymaps": shown(root.join("Keymaps")),
  }))
}

/// A folder (an empty one in OPFS still is one in the File view).
#[tauri::command]
pub fn handover_folder(app: AppHandle, store: String, path: String) -> Result<(), String> {
  let dir = target(&root(&app)?, &store, &path)?;
  fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// A file of the folder's (the soundfonts' index.json, to merge into).
#[tauri::command]
pub fn handover_read(app: AppHandle, store: String, path: String) -> Result<Response, String> {
  let file = target(&root(&app)?, &store, &path)?;
  fs::read(file).map(Response::new).map_err(|e| e.to_string())
}

/// The file's bytes in the body; x-mt-store, x-mt-path (percent-encoded) and
/// x-mt-replace (the modification time it was written with, "*", or empty:
/// create only) in the headers. Answers { written, same, mtime }.
#[tauri::command]
pub fn handover_write(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
  let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
  let path = percent_decode(&header("x-mt-path"))?;
  let file = target(&root(&app)?, &header("x-mt-store"), &path)?;
  let replace = header("x-mt-replace");
  let body: &[u8] = match request.body() {
    InvokeBody::Raw(bytes) => bytes,
    InvokeBody::Json(_) => &[],
  };
  let done = write(&file, body, (!replace.is_empty()).then_some(replace.as_str()))?;
  Ok(json!({ "written": done.written, "same": done.same, "mtime": done.mtime }))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_every_system_can_hold() {
    for ok in ["song.taud", "Album 2", "한국어 곡.taud", "con-man.taud", "com0", "a.b"] {
      assert!(portable(ok), "{ok}");
    }
    for bad in ["", ".", "..", "a:b", "what?", "a|b", "a/b", "a\\b", "con", "CON.taud", "nul.txt", "com1", "LPT9.x", "dot.", "space ", " lead"] {
      assert!(!portable(bad), "{bad}");
    }
  }

  #[test]
  fn paths_decode() {
    assert_eq!(percent_decode("Album%202/c%25d.taud").unwrap(), "Album 2/c%d.taud");
    assert_eq!(percent_decode("%ED%95%9C").unwrap(), "한");
    assert!(percent_decode("%4").is_err());
  }

  #[test]
  fn creates_keeps_and_replaces_only_its_own() {
    let dir = std::env::temp_dir().join(format!("microtone-handover-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let file = dir.join("Projects/Album/song.taud");

    // Created, folders and all.
    let first = write(&file, b"one", None).unwrap();
    assert!(first.written && !first.same);
    // The same bytes again: nothing to do.
    assert_eq!(write(&file, b"one", None).unwrap(), Written { written: false, same: true, mtime: first.mtime });
    // Other bytes, create-only: someone's file, left alone.
    let theirs = write(&file, b"two", None).unwrap();
    assert!(!theirs.written && !theirs.same);
    assert_eq!(fs::read(&file).unwrap(), b"one");
    // Replaced while it is still what was written...
    let again = write(&file, b"two", Some(&first.mtime.to_string())).unwrap();
    assert!(again.written);
    assert_eq!(fs::read(&file).unwrap(), b"two");
    // ...but not once it has changed since (another mtime).
    let stale = write(&file, b"three", Some("1")).unwrap();
    assert!(!stale.written);
    assert_eq!(fs::read(&file).unwrap(), b"two");
    // "*": whatever is there (the merged index).
    assert!(write(&file, b"four", Some("*")).unwrap().written);
    assert_eq!(fs::read(&file).unwrap(), b"four");
    // No part file left behind.
    let left: Vec<_> = fs::read_dir(dir.join("Projects/Album")).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(left.len(), 1, "{left:?}");
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn stays_inside_its_stores() {
    let root = Path::new("/r");
    assert!(target(root, "projects", "../x").is_err());
    assert!(target(root, "projects", "a/../../x").is_err());
    assert!(target(root, "elsewhere", "x").is_err());
    assert!(target(root, "projects", "").is_err());
    assert_eq!(target(root, "keymaps", "Mine.taudkey").unwrap(), Path::new("/r/Keymaps/Mine.taudkey"));
  }
}
