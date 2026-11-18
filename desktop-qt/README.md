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

### Windows

Visual Studio 2022 (MSVC: QtWebEngine has no MinGW build), Qt ≥ 6.8 for
`msvc2022_64` with WebEngine (an *extension* in Qt's online installer since
6.8, beside the modules), HttpServer and WebSockets, CMake, Ninja and Node. From
an "x64 Native Tools" prompt:

```bat
cmake -S desktop-qt -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
windeployqt --release --no-compiler-runtime build\microtone.exe
copy "%VCToolsRedistDir%\x64\Microsoft.VC143.CRT\*.dll" build
node desktop-qt\tools\stage-frontend.js build\www
```

The Windows build has ASIO as well as WASAPI: RtAudio's ASIO backend with
Steinberg's SDK files, vendored from the same RtAudio release
(`vendor/rtaudio/include`; GPLv3, see `vendor/VENDOR-VERSIONS.md`). The C
runtime goes beside the app as DLLs ("local deployment"), not as
`vc_redist.x64.exe`, which needs an administrator to run.

The installer (NSIS 3, `installer/microtone.nsi`) is made from the packaged
folder:

```bat
node desktop-qt\tools\installer-files.js <app folder> build\installer-lists
makensis /INPUTCHARSET UTF8 /DVERSION=5.0.5 /DFILEVERSION=5.0.5.0 /DSTAGE=<app folder> ^
  /DLISTS=build\installer-lists /DOUTFILE=build\Microtone-5.0.5-windows-x64-setup.exe ^
  desktop-qt\installer\microtone.nsi
```

(`makensis.exe` from NSIS's Windows zip also runs under Wine, which is how it
was tested on Linux.)

`.github/workflows/desktop-qt.yml` does all of this on `windows-latest`, on a
push to `qt-native` or by hand, and keeps two artifacts:
`Microtone-<version>-windows-x64` (the app, its Qt and C runtimes, the staged
web app in `www\`, `LICENSE.txt`, `wasapi-probe.exe` and `asio-probe.exe`)
and `Microtone-<version>-windows-x64-setup` (the installer). It releases
nothing.

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

The output (audio system, device, sample rate, buffer) is chosen in the app's
**Settings** tab (Ctrl+,), which only the desktop app has, and remembered in
`<config>/Microtone/Microtone.conf` (`[audio]`; on Windows the registry,
`HKCU\Software\Microtone\Microtone`). The browser profile, which holds every
project, is in the app's local data folder: `~/.local/share/Microtone/Microtone`
on Linux, `%LOCALAPPDATA%\Microtone\Microtone` on Windows (not the roaming
folder: projects with samples are big). For a test run, the environment
overrides what is remembered:

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
  - **The engine always renders at 48 kHz, as in the browser.** A device at
    another rate hears it through the web build's own interpolator
    (`resampler.cpp`: `core/audio/resampler.js`'s Kaiser-windowed sinc and the
    worklet's shared-ring read loop, ported). The read position is a whole
    frame plus a fraction kept apart, so the samples do not depend on when
    playback started. A change of output therefore never touches the engine:
    the device closes, opens again, and playback carries on.
  - Ten seconds at 44.1 kHz match the worklet's read loop over the same render
    in all 882 000 samples.
  - **A device that goes away is opened again.** It may have been unplugged,
    or an ASIO driver may have asked to be reset because its own panel changed
    the buffer or the clock. The host reopens the same setting, or the defaults
    if that will not open, and sends the page a STATUS. RtAudio closes a reset
    ASIO stream on a thread of its own, and the reopen waits for that thread to
    end before loading a driver again. Tried on Linux with the stand-in WASAPI
    (`MICROTONE_FAKE_WASAPI_LOSE_AFTER=<seconds>`): the song plays straight
    through the reopen.
- **The Settings tab** (`microtone-worker/src/ui/views/settings.js`): it is
  laid out as the Samples and Instruments views are, with categories down the
  left.
  - *Audio*: the audio system as pushbuttons, the device and the sample rate
    as dropdowns, and the buffer as pushbuttons from 64 to 2048 frames. What is
    open is described in words, with whether the output is converted.
  - *Performance*: the callback's load, the engine's, dropouts, and the
    real-time scheduling the thread got, plus the profiler's verdict, while the
    category is open.
  - A change applies at once. One the device refuses puts the previous setting
    back, and the tab says why.
  - The host answers three requests of its own, besides the engine's
    commands: `HOST_DEVICES` (every API's output devices), `HOST_CONFIGURE`
    and `HOST_PANEL` (the ASIO driver's own window).
  - The tab exists only where `window.__MICROTONE_NATIVE__` does: the
    website's audio is the browser's.
- **WASAPI** (`wasapi.c`, Windows): our own, in C (COM through its C
  interface), because RtAudio's WASAPI has no exclusive mode, and takes the
  low-latency path whenever Windows has it, with no choice. Three modes, chosen
  in the Settings tab:
  - *shared*: through the Windows mixer, at its rate and its period (usually
    10 ms); the buffer asked for is the one behind that period;
  - *shared, low latency*: through the mixer at a shorter period, a multiple of
    the driver's step in its range (`IAudioClient3`, Windows 10 and later). A
    driver that refuses a period it listed gets its own default instead, and
    the tab shows the period it got;
  - *exclusive*: the device to ourselves, at the rate chosen in the tab. The
    sample format is the first the hardware takes: 32-bit float, then 24-in-32,
    24 or 32-bit PCM, then 16-bit PCM (TPDF-dithered). The period is no shorter
    than the device's minimum, with the buffer-alignment retry Windows asks for.

  Event-driven, on a thread of its own registered with MMCSS as "Pro Audio";
  everything COM about a stream happens on that thread. Devices are named by
  their endpoint ids, which stay the same between sessions. The device list
  gives each mode's limits per device, so the tab offers only rates and buffer
  sizes that will open, and disables a mode a device lacks. A first start
  tries low-latency shared, then shared.
  - `tools/wasapi-probe.c` (built beside the app on Windows) lists what WASAPI
    offers and plays a test tone through each mode.
  - `wasapi_fake.c` stands in for it elsewhere (`-DMICROTONE_FAKE_WASAPI=ON`,
    testing only), so the host's WASAPI glue and the tab's modes can be tried
    on Linux.
  - Checked under Wine 11 with the MinGW build of the probe:
    - enumeration (names, endpoint ids, mixer formats, low-latency ranges);
    - shared: 10 ms period, 200 callbacks in 2 s, no glitches, and the 440 Hz
      tone recorded off the sink at the right level;
    - low latency at 256 frames: 5.33 ms, 377 callbacks in 2 s;
    - Wine's own listed minimum is refused, and the default retry opens it;
    - exclusive: Wine offers none, and that refusal is reported.
  - On real Windows (2026-11-18): the CI build (MSVC, Qt 6.8.3, the
    windeployqt package) runs, and all three modes play as intended.
- **ASIO** (Windows): RtAudio's backend, with Steinberg's SDK files from the
  same release. A driver is a device. Unlike WASAPI, the buffer and the clock
  belong to the driver, which has a settings window of its own:
  - The tab's first buffer choice is *Driver's* (`bufferFrames` 0): the size
    the driver's window is set to, RtAudio's "preferred". It is the default
    whenever ASIO is chosen. Other sizes are those the open driver allows
    (`asiodriver.cpp`: `ASIOGetBufferSize`, sent as the status's
    `bufferLimits`), and RtAudio fits a size to the driver's granularity.
  - *Driver settings…* opens that window (`ASIOControlPanel`). A change made
    there arrives as the driver's reset request, so the stream is opened again
    at the new size or rate.
  - The status gives the driver's sample format (RtAudio converts to it) and
    the latency it reports, which already includes the buffer. The callback
    runs on the driver's own thread, at the priority the driver gives it.
  - ASIO is never the first choice: a first start goes to WASAPI, and ASIO is
    the last fallback.
  - `tools/asio-probe.cpp` (built beside the app) lists the drivers, their
    rates, formats and buffer sizes, plays a tone through one, or opens one's
    window.
  - Not yet run against a real driver: Wine has none, and there is no MinGW
    C++ compiler here. The tab's ASIO branch was checked on Linux against a
    stubbed host (the driver's size, the limits, the window's button, and the
    switch from WASAPI asking for the driver's size).
- **`links`**: `docs.html` opens in the docs window, other pages of the app in
  the main window, `http(s):` and `mailto:` in the system browser. The window a
  link was clicked in never navigates away from an open project.

## The Windows installer

`installer/microtone.nsi` (NSIS 3, Unicode, English and Korean by Windows'
language):

- **For one person, with no administrator rights.** It installs into
  `%LOCALAPPDATA%\Programs\Microtone`, or wherever the last install went. It
  adds a Start menu shortcut, a desktop one if asked on the last page, and an
  entry in Windows' list of apps under the key `cc.microtone.desktop`. The
  Tauri build's own entry, `Microtone`, is left alone, and so is its data
  (`%LOCALAPPDATA%\cc.microtone.desktop`). Both builds' shortcuts are named
  "Microtone", so with both installed the newer shortcut wins, and each
  uninstaller removes a shortcut only if it points at its own exe.
- **The uninstaller removes what the installer put there, by name, and nothing
  else.** `tools/installer-files.js` writes both lists from the packaged
  folder. It never runs `RMDir /r` on a folder someone chose, so a file of
  yours in that folder stays. An install over an earlier one first runs the
  earlier one's uninstaller (`/S /UPDATE`), so files a version stopped
  shipping go too.
- **Projects stay unless asked.** The uninstaller's first page asks whether to
  delete the projects and settings too (off by default). If ticked, it removes
  `%LOCALAPPDATA%\Microtone\Microtone` and `HKCU\Software\Microtone\Microtone`.
- **Microtone must be closed.** The app holds the mutex
  `Local\microtone-desktop` (`main.cpp`). If it is held, the installer asks
  you to close the app and retry. Unattended, it waits up to ten seconds, then
  stops with exit code 2.
- **The licence page is not an agreement.** The GPL asks for none, so its
  button is Next, not "I Agree".
- Switches, besides NSIS's `/S` and `/D=`: `/P` (passive: only the progress,
  for an update) and `/R` (with `/P` or `/S`, start Microtone afterwards).
- Tested under Wine with the CI artifact:
  - a silent install matches the packaged folder byte for byte;
  - an upgrade drops an older version's extra files (a `$` in a name
    included) and keeps the user's own;
  - uninstalling removes everything it installed and leaves a same-named
    shortcut that points elsewhere;
  - the running-app check waits, or gives up with exit code 2;
  - "delete my projects" removes the Qt build's data and settings but not the
    Tauri build's;
  - the pages draw in English and Korean.
- Not code-signed, so Windows SmartScreen warns about an unknown publisher.

## Not yet done

- Online projects (sign-in through the system browser, the access token, the
  `/api/online` proxy). The page's requests already reach this server, which
  answers them 404 for now.
- The updater and the deep-link scheme. The installer already takes `/P /R`,
  the switches an updater runs it with.
- Linux and macOS packaging (AppImage, .deb/.rpm, .dmg) and their CI.
- Code signing, and the third-party notices a release must ship (Qt and
  Chromium's licences, RtAudio's, the ASIO SDK's).
- Moving projects over from the Tauri build.
- The native audio host's next steps:
  - ASIO on a real driver (above);
  - the macOS build (CoreAudio), and JACK on Linux;
  - audio input for the sampler's Record, and MIDI;
  - whether PulseAudio's simple API reports underflows at all (RtAudio's
    status flag): the 0 above may mean "none", or "not reported".
