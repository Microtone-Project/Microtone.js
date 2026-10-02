# Microtone desktop

Microtone as a desktop application: the web app in `../microtone-worker`, in a
[Tauri 2](https://v2.tauri.app/) window, updating itself through the
[updater plugin](https://v2.tauri.app/plugin/updater/). Nothing in this directory
is part of microtone.cc, and `microtone-worker` knows nothing about it — the app
is the same site the server serves, embedded in the binary.

## Building

You need Rust (stable), the Tauri CLI and Node ≥ 22:

```sh
cargo install tauri-cli --version "^2" --locked
```

and, on Linux, WebKitGTK and friends — on openSUSE

```sh
sudo zypper in webkitgtk3-devel libopenssl-devel librsvg-devel libappindicator3-devel
```

on Debian or Ubuntu

```sh
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

Then, from this directory:

```sh
cargo tauri dev      # run it, from the CLI's dev server
cargo tauri build    # bundles in target/release/bundle/
cargo test           # the Rust unit tests
```

Both copy the shipped part of `microtone-worker` into `dist/` first
(`tools/stage-frontend.js`: what git would commit there, less `.assetsignore`
and the test suite and dev tools). A local build makes unsigned bundles without
updater artefacts and needs no key.

## Releasing

**Raise `"version"` in `microtone-worker/package.json` and push to master.**
That is the whole procedure: `.github/workflows/desktop.yml` builds Linux
(AppImage, .deb, .rpm), Windows (NSIS installer) and macOS (universal .app and
.dmg) for any version that has no `v<version>` release yet, signs the updater
artefacts, and publishes the release with its `latest.json` once every platform
has uploaded. Installed copies look at
`https://github.com/Microtone-Project/Microtone.js/releases/latest/download/latest.json`.

Once, before the first release:

1. `cargo tauri signer generate -w ~/.tauri/microtone.key` — choose a password.
2. Put the public key it prints into `tauri.conf.json` → `plugins.updater.pubkey`
   (the workflow refuses to release while the placeholder is there).
3. Add two repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (the contents of
   `~/.tauri/microtone.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep the private key and its password somewhere safe. An installed copy only
accepts updates signed with it: lose it, and every copy out there has to be
reinstalled by hand.

## What the shell does

A browser does a few things for a page that a bare webview does not. They are
done here, in Rust, or in `glue/desktop.js`, which every page gets as an
initialization script:

| | |
|---|---|
| `src/links.rs` | `docs.html` (the manual, the patch notes) opens in a window of its own; links to websites open in the browser; the main window never navigates away from an open project |
| `src/saving.rs` | an export (a blob + `<a download>`) downloads into a staging folder, then a native Save dialog asks where it goes |
| `src/closing.rs` | closing the window runs the page's `beforeunload`, so an unsaved project asks first, as a browser tab does |
| `src/updates.rs` | checks for an update a few seconds after start-up; the glue's banner offers Download, then Restart now or When I quit |
| `src/online.rs` | online projects: signs in through the system's browser, keeps an access token, and sends the page's `/api/online` requests to microtone.cc with it |
| `src/webkitgtk.rs` | Linux: switches on the Storage and File System APIs (where every project lives) and the microphone, which WebKitGTK ships switched off |
| `src/mac_dialogs.rs` | macOS: `alert()` and `confirm()`, which WKWebView lacks, as native alerts |

### Online projects

The website's own client (`src/storage/online.js`) runs unchanged. The glue hands
its `fetch()` calls to `/api/online` to `online_request`, which sends them to
microtone.cc with `Authorization: Bearer <token>` — from the app, so there is no
CORS and no third-party cookie for a webview to drop — and its sign-in
`window.open` to `online_sign_in`, which opens the system's browser (RFC 8252):

1. The app makes a PKCE verifier and a state, and opens
   `https://microtone.cc/api/online/auth/desktop?challenge=…&state=…`.
2. A browser already signed in to the site hands off at once; otherwise the
   ordinary SceneID sign-in runs first. The hand-off page sends the browser to
   `cc.microtone.desktop:/signed-in?code=…&state=…`.
3. The operating system starts the app with that link (a second instance gives
   it to the first). The state must be the one the app made; the code and the
   verifier go to `POST /api/online/auth/token`, which answers with the token.
4. The token is kept in the app's data folder (`online-token`, owner-only) and
   the File tab is told, as the website's sign-in window tells it. Signing out,
   or a 401, forgets it.

The scheme is registered by the installers (.deb, .rpm, NSIS, the .app); an
AppImage, or a build run from `target/`, registers it itself at start-up. The
server's half is `microtone-worker/server/online/desktop.js`, and its
`desktop_codes` table needs `npx wrangler d1 migrations apply microtone-online
--remote` (from the repository root) once, before the first desktop release
that signs in.

A debug build can be pointed at a local server instead of microtone.cc. From the
repository root, with the test sign-in (the blank `SCENEID_CLIENT_ID` keeps
SceneID out of it even when `.dev.vars` has it):

```sh
npx wrangler d1 migrations apply microtone-online --local
npx wrangler dev --port 8790 --var ONLINE_DEV_LOGIN:1 --var SCENEID_CLIENT_ID:
```

then, from here, `MICROTONE_ONLINE=http://127.0.0.1:8790 cargo tauri dev`.

Two things not to do, each learnt the hard way:

- **Do not add `tauri-plugin-dialog`.** Its init script replaces
  `window.confirm` with an async version, and the app's
  `if (!confirm(…)) return;` would then never stop anything.
- **Do not use `rfd` on Linux.** It runs GTK on a thread of its own, which then
  handles this app's window events too.

## Things to know

- `identifier` (`cc.microtone.desktop`) names the folder the webview keeps its
  storage in — every project. Changing it, or the Windows origin
  (`http://tauri.localhost`), leaves everyone's projects behind.
- The desktop app's projects are its own: it does not share storage with a
  browser. Moving work between the two is **Export** in one and **Open…** in
  the other, or the online projects, which both reach.
- The Linux webview is not cross-origin isolated, so the audio engine runs in
  the AudioWorklet (the app's non-isolated path) rather than in a render worker.
- The fonts come from Google Fonts; offline, the app falls back to system fonts.
- The Windows and macOS builds are not code-signed: Windows SmartScreen and
  macOS Gatekeeper warn the first time.
