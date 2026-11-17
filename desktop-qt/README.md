# Microtone desktop — Qt build

Microtone as a desktop application: the web app in `../microtone-worker`, in a
QtWebEngine (Chromium) window, served by the shell itself. This is the
successor to the Tauri build in `../desktop` (item 336 in the TODO list has
the measurements). On Linux, WebKitGTK delivers the audio port's blocks through
the page's main thread, so the bigger the window, the more the sound drops out.
Chromium does not.

## Building

You need CMake ≥ 3.21, a C and C++17 compiler and Qt ≥ 6.8 with **WebEngine**,
**HttpServer** and **WebSockets** (and **DBus** on Linux), plus, on Linux, the
ALSA and PulseAudio headers (JACK's too, if you want that backend). On
openSUSE:

```sh
sudo zypper in cmake gcc-c++ qt6-base-devel qt6-webenginecore-devel qt6-webenginewidgets-devel \
  qt6-httpserver-devel qt6-websockets-devel qt6-dbus-devel alsa-devel libpulse-devel
```

RtAudio is vendored (`vendor/rtaudio`, see `vendor/VENDOR-VERSIONS.md`); the C
engine is compiled from `../core/engine/c` with the WebAssembly build's flags
(`-ffp-contract=off`, LTO, never `-ffast-math`).

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
microtone [--root <dir>] [--open <page>] [--web-audio]
```

- `--root <dir>` serves the web app from `<dir>`. The default is the staged
  copy beside the binary (`www/`, `../share/microtone/www/` or
  `../Resources/www/`), else the working tree a dev build was configured from.
- `--open <page>` opens `<page>` instead of `index.html`, e.g.
  `"index.html?load=assets/demo_projects/Eighth.taud&autoplay&profile=1"`.
- `--web-audio` plays through the page's own Web Audio (worklet + render
  Worker, as in a browser) instead of the native audio host.
- Chromium's own switches pass through, and so does `QTWEBENGINE_CHROMIUM_FLAGS`.
  `QTWEBENGINE_REMOTE_DEBUGGING=<port>` opens the DevTools protocol, which is
  how the app is driven in tests.

The native audio host reads:

- `MICROTONE_AUDIO_API`: `pulse`, `alsa`, `jack` (Linux), `wasapi`, `asio`
  (Windows), `core` (macOS). Default on Linux: PulseAudio (PipeWire answers
  it, and it follows the desktop's choice of output), then ALSA, then JACK.
- `MICROTONE_BUFFER_FRAMES`: the device buffer; default 256 (5.3 ms at 48 kHz).
  64 and 128 run here with room to spare (below).
- `MICROTONE_NATIVE_DUMP=<file>` (+ `MICROTONE_NATIVE_DUMP_SECONDS`, default
  30): keep what the engine rendered, as interleaved stereo float, and write
  it out once full. This is how the host is checked against the WebAssembly
  engine.

Testing it headless on a Wayland session: Qt picks Wayland over `DISPLAY`
and opens on the real desktop. Run on Xvfb with
`env -u WAYLAND_DISPLAY QT_QPA_PLATFORM=xcb DISPLAY=:N`. Point the XDG
directories (`XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`) at scratch
folders to keep your own projects out of it. To keep the sound off the
speakers, give the test its own sink: `pactl load-module module-null-sink
sink_name=microtone_test` (it prints the module number to unload afterwards),
then `PULSE_SINK=microtone_test` for the app.

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
- **The native audio host** (`nativeaudio`, `enginehost.c`): the engine runs
  in the shell, in C, on the audio device's own callback, and the page talks
  to it over a WebSocket. The engine is the same C the web build compiles to
  WebAssembly, with the same flags.
  - **The callback renders exactly what the device asks for.** It renders in
    spans of up to a chunk (`te_render_frames`), with no ring and no extra
    latency beyond the device's buffer.
  - **The page drives it with the same commands.** The shell gives every page
    `window.__MICROTONE_NATIVE__ = { engine: "ws://microtone.localhost/engine?t=<token>", … }`.
    `core/audio/audio-system.js` then sends there the same CMD protocol it
    would send a worklet or Worker. `core/audio/native-engine.js` lowers each
    command to the C arguments, with WasmTaudEngine's own conversions and
    encoders; `enginehost.c` is that dispatcher in C.
  - **Snapshots come back as the ranges that are current.** A meter that is
    off sends nothing.
  - **No device, and nothing changes.** The page plays through Web Audio as in
    a browser.
  - **The engine lock.** The page's commands are applied on the GUI thread
    under it. The callback only tries for it: it spins for at most a quarter
    of its period, then plays silence and counts an xrun. Snapshots leave
    through a triple buffer, so the callback never waits for the GUI, and the
    interrupts of a snapshot nobody collected ride along in the next.
  - **Real-time scheduling.** A desktop session gives an ordinary process no
    real-time priority, and a preempted render overran 64-frame buffers by
    3×. The shell asks the session's RealtimeKit for `SCHED_FIFO` on the
    callback's thread, as PipeWire does.
  - **Measured** (Ryzen 9950X, `Eighth.taud` at 3840×2160, software-rendered
    Xvfb, PulseAudio on PipeWire):
    - the slowest callback was 0.5–0.9 ms against a 1.33 ms period at 64
      frames, and 0.7–1.7 ms against 2.67 ms at 128;
    - the engine used 11–21 % of real time;
    - 0 xruns and 0 lock misses.
  - **The same audio as the web build.** Twenty seconds captured from the
    callback (256-frame buffers) are bit-identical to the WebAssembly engine's
    offline render of the same song.
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
- The native audio host's next steps:
  - a desktop settings tab to choose the device, the API and the buffer;
  - the Windows build (WASAPI, and ASIO with the SDK files RtAudio ships), the
    macOS build (CoreAudio), and JACK on Linux;
  - audio input for the sampler's Record, and MIDI;
  - whether PulseAudio's simple API reports underflows at all (RtAudio's
    status flag): the 0 above may mean "none", or "not reported".
