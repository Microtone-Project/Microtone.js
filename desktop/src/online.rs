// Online projects (microtone-worker/server/online/). The app signs in through
// the system's browser and keeps an ACCESS TOKEN; every /api/online request the
// page makes is sent from here, with it.
//
// Why from here: the page is tauri://localhost and the API is microtone.cc.
// Fetched by the webview that is a cross-site request — CORS, and a session
// cookie the webviews drop as third-party. Sent by the app it is neither, and
// src/storage/online.js stays exactly what the website runs: the glue
// (glue/desktop.js) hands this module the page's fetch() calls to /api/online
// and its sign-in window.open().
//
// Signing in — RFC 8252 with PKCE (RFC 7636); server/online/desktop.js is the
// other half:
//   online_sign_in   make a verifier and a state, keep them here, and open the
//                    browser at <server>/api/online/auth/desktop?challenge=
//                    S256(verifier)&state=…
//   (the browser)    is signed in already, or signs in; its page hands off to
//                    cc.microtone.desktop:/signed-in?code=…&state=…
//   deep_link        the OS hands that URL to the app (main.rs). The state must
//                    be the one kept here; POST /auth/token {code, verifier}
//                    gives the token, kept in <app data>/online-token, and the
//                    page hears "signed-in" on the channel the website's own
//                    sign-in window announces on.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;

use crate::MAIN;

/// The app's URI scheme (tauri.conf.json, plugins.deep-link) and the path the
/// server's hand-off page sends codes to.
const SCHEME: &str = "cc.microtone.desktop";
const RETURN_PATH: &str = "/signed-in";

/// A sign-in left half-way in the browser is abandoned after this.
const SIGN_IN_TTL: Duration = Duration::from_secs(30 * 60);

/// The page's request headers that go on to the server; nothing else does.
const FORWARDED: [&str; 3] = ["content-type", "if-match", "accept"];
/// …and the answer's that come back.
const RETURNED: [&str; 3] = ["content-type", "etag", "content-length"];

/// Where the API is. A debug build can be pointed at `wrangler dev` with
/// MICROTONE_ONLINE=http://127.0.0.1:8790; a release only ever talks to the site.
fn server() -> String {
  if cfg!(debug_assertions)
    && let Ok(url) = std::env::var("MICROTONE_ONLINE")
  {
    return url.trim_end_matches('/').to_string();
  }
  "https://microtone.cc".to_string()
}

#[derive(Default)]
pub struct Online {
  token: Mutex<Option<String>>,
  pending: Mutex<Option<Pending>>,
  client: std::sync::OnceLock<reqwest::Client>,
}

/// The sign-in this app started and is waiting on.
struct Pending {
  verifier: String,
  state: String,
  started: Instant,
}

impl Online {
  fn client(&self) -> &reqwest::Client {
    self.client.get_or_init(|| {
      // reqwest is built without a TLS crypto provider (as the updater's is);
      // whichever of the two asks first installs ring for both.
      let _ = rustls::crypto::ring::default_provider().install_default();
      reqwest::Client::builder()
        .user_agent("Microtone-desktop")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .expect("an HTTP client")
    })
  }

  fn token(&self) -> Option<String> {
    self.token.lock().unwrap().clone()
  }
}

fn token_file(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_data_dir().ok().map(|dir| dir.join("online-token"))
}

/// At start-up: the token from last time, if any.
pub fn load(app: &AppHandle) {
  let token = token_file(app)
    .and_then(|file| std::fs::read_to_string(file).ok())
    .map(|text| text.trim().to_string())
    .filter(|token| !token.is_empty());
  *app.state::<Online>().token.lock().unwrap() = token;
}

fn keep_token(app: &AppHandle, token: Option<&str>) {
  *app.state::<Online>().token.lock().unwrap() = token.map(str::to_string);
  let Some(file) = token_file(app) else { return };
  match token {
    Some(token) => {
      if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
      }
      if let Err(err) = write_private(&file, token) {
        eprintln!("microtone: could not keep the online token: {err}");
      }
    }
    None => {
      let _ = std::fs::remove_file(file);
    }
  }
}

/// Readable by its owner only: it is as good as a password for eight slots.
fn write_private(file: &PathBuf, token: &str) -> std::io::Result<()> {
  use std::io::Write;
  let mut options = std::fs::OpenOptions::new();
  options.write(true).create(true).truncate(true);
  #[cfg(unix)]
  std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
  options.open(file)?.write_all(token.as_bytes())
}

/// RFC 7636 S256: BASE64URL(SHA-256(verifier)), unpadded.
fn s256(verifier: &str) -> String {
  URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_b64url(bytes: usize) -> Result<String, String> {
  let mut buf = vec![0u8; bytes];
  getrandom::fill(&mut buf).map_err(|err| err.to_string())?;
  Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// Is `path` (with its query) a request for the online API, and nothing else?
fn api_path(path: &str) -> bool {
  (path == "/api/online" || path.starts_with("/api/online/") || path.starts_with("/api/online?"))
    && !path.contains("..")
    && !path.contains('#')
}

/// The page's fetch() to /api/online, sent with the token. The body arrives
/// raw; method, path and the page's headers ride in x-mt-* headers. Answers
/// [u32 BE length][{"status", "headers"} as JSON][body] — one raw IPC reply —
/// or fails with "offline" when the server could not be reached, which the
/// glue turns into the TypeError a failed fetch() throws.
#[tauri::command]
pub async fn online_request(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
  let header = |name: &str| {
    request.headers().get(name).and_then(|value| value.to_str().ok()).unwrap_or("").to_string()
  };
  let method = reqwest::Method::from_bytes(header("x-mt-method").as_bytes()).map_err(|_| "bad method")?;
  let path = header("x-mt-path");
  if !api_path(&path) {
    return Err(format!("not an online API path: {path}"));
  }
  let page_headers: Vec<(String, String)> = serde_json::from_str(&header("x-mt-headers")).unwrap_or_default();
  let body = match request.body() {
    InvokeBody::Raw(bytes) => bytes.clone(),
    InvokeBody::Json(_) => Vec::new(),
  };

  let online = app.state::<Online>();
  let mut outgoing = online.client().request(method.clone(), format!("{}{path}", server()));
  for (name, value) in &page_headers {
    if FORWARDED.contains(&name.to_ascii_lowercase().as_str()) {
      outgoing = outgoing.header(name, value);
    }
  }
  let token = online.token();
  if let Some(token) = &token {
    outgoing = outgoing.bearer_auth(token);
  }
  if !body.is_empty() {
    outgoing = outgoing.body(body);
  }

  let answer = outgoing.send().await;
  let signing_out = method == reqwest::Method::POST && path.starts_with("/api/online/auth/logout");
  if signing_out {
    // Gone here whatever the server says: signing out must not depend on it.
    keep_token(&app, None);
  }
  let answer = answer.map_err(|_| "offline".to_string())?;
  let status = answer.status().as_u16();
  if status == 401 && token.is_some() {
    // Expired or ended elsewhere: a token the server no longer knows is no token.
    keep_token(&app, None);
  }
  let headers: Vec<(String, String)> = RETURNED
    .iter()
    .filter_map(|name| {
      answer.headers().get(*name).and_then(|value| value.to_str().ok()).map(|value| (name.to_string(), value.to_string()))
    })
    .collect();
  let bytes = answer.bytes().await.map_err(|_| "offline".to_string())?;

  let meta = serde_json::to_vec(&serde_json::json!({ "status": status, "headers": headers })).map_err(|err| err.to_string())?;
  let mut packet = Vec::with_capacity(4 + meta.len() + bytes.len());
  packet.extend_from_slice(&(meta.len() as u32).to_be_bytes());
  packet.extend_from_slice(&meta);
  packet.extend_from_slice(&bytes);
  Ok(Response::new(packet))
}

/// The page's "Sign in" (its window.open of /api/online/auth/login): open the
/// system's browser on the server's desktop sign-in.
#[tauri::command]
pub fn online_sign_in(app: AppHandle) -> Result<(), String> {
  let verifier = random_b64url(32)?;
  let state = random_b64url(16)?;
  let url = format!(
    "{}/api/online/auth/desktop?challenge={}&state={state}",
    server(),
    s256(&verifier)
  );
  *app.state::<Online>().pending.lock().unwrap() = Some(Pending { verifier, state, started: Instant::now() });
  app.opener().open_url(url, None::<&str>).map_err(|err| err.to_string())
}

/// A URL the OS handed the app (main.rs, from the deep-link plugin).
pub fn deep_link(app: &AppHandle, url: &Url) {
  let Some((code, state)) = returned_code(url) else { return };
  let online = app.state::<Online>();
  let pending = {
    let mut pending = online.pending.lock().unwrap();
    // Ours, and recent; anything else is a link this app never asked for.
    if pending.as_ref().is_some_and(|p| p.state == state && p.started.elapsed() < SIGN_IN_TTL) {
      pending.take()
    } else {
      None
    }
  };
  let Some(pending) = pending else {
    eprintln!("microtone: ignored a sign-in link this app did not ask for");
    return;
  };
  crate::links::focus_main(app);
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    match redeem(&app, &code, &pending.verifier).await {
      Ok(token) => {
        keep_token(&app, Some(&token));
        tell_page(&app, "signed-in", "");
      }
      Err(err) => {
        eprintln!("microtone: online sign-in did not complete: {err}");
        tell_page(&app, "sign-in-failed", &err);
      }
    }
  });
}

/// cc.microtone.desktop:/signed-in?code=…&state=… → (code, state).
fn returned_code(url: &Url) -> Option<(String, String)> {
  if url.scheme() != SCHEME || url.path().trim_end_matches('/') != RETURN_PATH {
    return None;
  }
  let find = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
  Some((find("code")?, find("state")?))
}

#[derive(Deserialize)]
struct Granted {
  token: String,
}

async fn redeem(app: &AppHandle, code: &str, verifier: &str) -> Result<String, String> {
  let answer = app
    .state::<Online>()
    .client()
    .post(format!("{}/api/online/auth/token", server()))
    .json(&serde_json::json!({ "code": code, "verifier": verifier }))
    .send()
    .await
    .map_err(|err| err.to_string())?;
  if !answer.status().is_success() {
    return Err(format!("the server answered {}", answer.status()));
  }
  let granted: Granted = answer.json().await.map_err(|err| err.to_string())?;
  Ok(granted.token)
}

fn tell_page(app: &AppHandle, kind: &str, error: &str) {
  if let Some(main) = app.get_webview_window(MAIN) {
    let args = serde_json::json!([kind, error]);
    let _ = main.eval(format!("window.__microtoneDesktop?.onlineAuth(...{args})"));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn s256_is_rfc_7636s() {
    // RFC 7636 Appendix B — test/node/online-desktop.test.js checks the server's.
    assert_eq!(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  }

  #[test]
  fn verifiers_are_what_rfc_7636_asks() {
    let verifier = random_b64url(32).unwrap();
    assert_eq!(verifier.len(), 43);
    assert!(verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    assert_ne!(verifier, random_b64url(32).unwrap());
  }

  #[test]
  fn only_the_api_goes_out() {
    assert!(api_path("/api/online/me"));
    assert!(api_path("/api/online/projects?name=a.taud"));
    assert!(api_path("/api/online/projects/p_0123456789abcdef"));
    assert!(!api_path("/api/onlinex"));
    assert!(!api_path("/index.html"));
    assert!(!api_path("/api/online/../../etc"));
    assert!(!api_path("https://evil.example/api/online/me"));
  }

  #[test]
  fn the_way_back() {
    let url = |s: &str| Url::parse(s).unwrap();
    assert_eq!(
      returned_code(&url("cc.microtone.desktop:/signed-in?code=abc&state=xyz")),
      Some(("abc".into(), "xyz".into()))
    );
    assert_eq!(returned_code(&url("cc.microtone.desktop:/signed-in?code=abc")), None);
    assert_eq!(returned_code(&url("cc.microtone.desktop:/elsewhere?code=abc&state=xyz")), None);
    assert_eq!(returned_code(&url("https://microtone.cc/signed-in?code=abc&state=xyz")), None);
  }
}
