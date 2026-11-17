# Microtone desktop — Qt build

Microtone as a desktop application: the web app in `../microtone-worker`, in a
QtWebEngine (Chromium) window, served by the shell itself. This is the
successor to the Tauri build in `../desktop` (item 336 in the TODO list has
the measurements). On Linux, WebKitGTK delivers the audio port's blocks through
the page's main thread, so the bigger the window, the more the sound drops out.
Chromium does not.

## Building

You need CMake ≥ 3.21, a C++17 compiler and Qt ≥ 6.8 with **WebEngine** and
**HttpServer**. On openSUSE:

```sh
sudo zypper in cmake gcc-c++ qt6-base-devel qt6-webenginecore-devel qt6-webenginewidgets-devel qt6-httpserver-devel
```

Then, from this directory:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build -j
build/microtone
```

A build run from its build tree serves the working tree's `microtone-worker`
directly (no staging step), so an edit to the web app shows on the next
reload.

**Dev packages newer than the installed Qt** (a rolling distribution caught
mid-upgrade): the build then fails to configure, or to link. Update the whole
system (`sudo zypper dup`) rather than mixing versions.
`-DQT_NO_PACKAGE_VERSION_CHECK=TRUE` gets past the configure step, and the
linker refuses any symbol the older libraries lack. But code compiled against
newer headers is not guaranteed to run on older libraries.

## Running

```
microtone [--root <dir>] [--open <page>]
```

- `--root <dir>` serves the web app from `<dir>`. The default is the staged
  copy beside the binary (`www/`, `../share/microtone/www/` or
  `../Resources/www/`), else the working tree a dev build was configured from.
- `--open <page>` opens `<page>` instead of `index.html`, e.g.
  `"index.html?load=assets/demo_projects/Eighth.taud&autoplay&profile=1"`.
- Chromium's own switches pass through, and so does `QTWEBENGINE_CHROMIUM_FLAGS`.
  `QTWEBENGINE_REMOTE_DEBUGGING=<port>` opens the DevTools protocol, which is
  how the app is driven in tests.

Testing it headless on a Wayland session: Qt picks Wayland over `DISPLAY`
and opens on the real desktop. Run on Xvfb with
`env -u WAYLAND_DISPLAY QT_QPA_PLATFORM=xcb DISPLAY=:N`. Point the XDG
directories (`XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`) at scratch
folders to keep your own projects out of it.

## How it works

- **`appserver`**: a loopback HTTP server (QHttpServer on 127.0.0.1, an
  ephemeral port) serving the web app with COOP/COEP and `Cache-Control:
  no-store`.
  - Why a server and not a custom URL scheme: Chromium keeps OPFS, where every
    project lives, away from custom schemes, and never cross-origin isolates
    them.
  - **The origin is `http://microtone.localhost` with no port.** OPFS is keyed
    by the origin, so it must never change. Chromium's
    `--host-resolver-rules="MAP microtone.localhost 127.0.0.1:<port>"` sends
    the name to whatever port the server got. The page is cross-origin
    isolated, so it gets SharedArrayBuffer and the shared-memory audio ring.
    The quotes matter: unquoted, the rule falls apart and the name resolves to
    loopback port 80.
  - Only the app's own webview may use the server. The profile's request
    interceptor adds a per-launch token (`X-Microtone-Shell`) to every request
    for that host, and the server refuses a request without it, or with any
    other `Host`.
- **`shell`**: the browser profile (kept in the app's data directory) and the
  main and docs windows. It also does what a browser would do for the page:
  - Closing the main window asks the page's own `beforeunload` (the unsaved
    project guard) and, if the project is dirty, asks you in the page's
    language. A page that never answers does not make the window unclosable.
  - A download becomes a native Save dialog.
  - The microphone is granted (the sampler's Record).
  - The context menu offers only editing, never Back, Reload or View source.
  - The welcome screen's "Get the desktop app" is hidden.
  - A second launch hands over to the first: two instances would share one
    profile.
- **`links`**: `docs.html` opens in the docs window, other pages of the app in
  the main window, `http(s):` and `mailto:` in the system browser. The window a
  link was clicked in never navigates away from an open project.

## Not yet done

- Online projects (sign-in through the system browser, the access token, the
  `/api/online` proxy). The page's requests already reach this server, which
  answers them 404 for now.
- The updater, the deep-link scheme, release staging (`tools/stage-site.js`
  into `www/`), packaging (AppImage, NSIS, .dmg) and CI.
- Moving projects over from the Tauri build.
- The native audio host (the C engine and the device in the shell, the page
  talking to it over a socket): the reason for this build, next.
