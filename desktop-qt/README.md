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
web app in `www\`, `LICENSE.txt`, `wasapi-probe.exe`, `asio-probe.exe`,
`microtone.pdb` and `diagnostics.cmd`)
and `Microtone-<version>-windows-x64-setup` (the installer). It releases
nothing.

### macOS

Xcode's command-line tools, CMake, Node and Qt ≥ 6.8 for macOS with the same
modules (Qt's macOS build is universal, so the app can be too). macOS 12 is
the floor (Qt 6.8's):

```sh
cmake -S desktop-qt -B build -DCMAKE_BUILD_TYPE=Release "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64"
cmake --build build --parallel
node desktop-qt/tools/stage-frontend.js build/Microtone.app/Contents/Resources/www
macdeployqt build/Microtone.app
codesign --force --deep --sign - build/Microtone.app
```

Qt 6.8.3's CMake files link Apple's AGL framework, which Xcode 26's SDK no
longer has; `CMakeLists.txt` takes it off the link.

The workflow's `macos` job does this on `macos-latest` and keeps
`Microtone-<version>-macos` (a .dmg: the app and an Applications link). Then
it runs the smoke test below against the packaged app, into the runner's own
virtual sound device; its report is in the run's summary.

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
`HKCU\Software\Microtone\Microtone`). The projects, soundfonts and keymaps
are ordinary files in `~/Microtone` (`%USERPROFILE%\Microtone` on Windows; see
"The file store" below). The browser profile (the page's preferences), the
logs and the autosave copies are in the app's local data folder:
`~/.local/share/Microtone/Microtone` on Linux,
`%LOCALAPPDATA%\Microtone\Microtone` on Windows. For a test run, the
environment overrides what is remembered:

- `MICROTONE_AUDIO_API`: `pulse`, `alsa`, `jack` (Linux), `wasapi`, `asio`
  (Windows), `core` (macOS). Default on Linux: PulseAudio (PipeWire answers
  it, and it follows the desktop's choice of output), then ALSA, then JACK.
- `MICROTONE_BUFFER_FRAMES`: the device buffer; default 256 (5.3 ms at 48 kHz).
  64 and 128 run here with room to spare (below).
- `MICROTONE_NATIVE_DUMP=<file>` (+ `MICROTONE_NATIVE_DUMP_SECONDS`, default
  30): keep what the engine rendered, as interleaved stereo float, and write
  it out once full. This is how the host is checked against the WebAssembly
  engine.

`MICROTONE_SAMPLE_RATE` asks for an output rate on a first start (nothing
remembered). `MICROTONE_FILES_ROOT=<dir>` puts the file store's folder
somewhere other than `~/Microtone`; tests use it to keep away from yours.

`tools/native-smoke.js <executable>` is the smoke test: it starts the app on
a demo song (`--song`, default `Eighth.taud`) and checks, over the DevTools
protocol, that the page is cross-origin isolated and has OPFS, and that the
native host plays. It then captures `--seconds` (default 10) of the host's
output at 48 kHz and compares it with the WebAssembly engine's render: it
must be bit-identical. Exit 0 if all is well, 1 if anything failed, 3 if no
audio device opened (the page was checked, the audio was not).

Testing it headless on a Wayland session: Qt picks Wayland over `DISPLAY`
and opens on the real desktop. Run on Xvfb with
`env -u WAYLAND_DISPLAY QT_QPA_PLATFORM=xcb DISPLAY=:N`. Point the XDG
directories (`XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`) at scratch
folders to keep your own projects out of it. To keep the sound off the
speakers, give the test its own sink: `pactl load-module module-null-sink
sink_name=microtone_test` (it prints the module number to unload afterwards),
then `PULSE_SINK=microtone_test` for the app.

## The file store: projects as files in ~/Microtone

In a browser the app keeps its projects in OPFS, the origin's private
storage, where nobody can see them. The desktop app keeps them as ordinary
files instead, in a folder of the person's own, to back up, sync or open like
any other (`src/filestore.cpp`):

    ~/Microtone/Projects     the File view's projects, folders and all
    ~/Microtone/Soundfonts   converted soundfonts (*.taud.sf2.gz), index.json (their notes)
    ~/Microtone/Keymaps      jam layouts (*.taudkey)

On Windows it is `%USERPROFILE%\Microtone`. The autosave copies stay private,
in the app's data folder.

- **The page does not change.** `src/storage/opfs.js` is a dispatcher: in a
  browser it uses `opfs-browser.js` (OPFS, as before), and where the shell
  gives the page `window.__MICROTONE_NATIVE__.files` it uses `native-files.js`.
  That module has the same functions, over `/api/files` on the shell's own
  server, behind the same per-launch token, and writes only from the page's
  own origin. A rename or a folder move is a real one, not a copy.
- **Names every system can hold.** The folder may be synced between Windows,
  macOS and Linux. So a name the store CREATES may not have `<>:"|?*` or
  control characters, a trailing dot or space, or be CON, PRN and the like.
  The page's `validName` says so before it asks. Files already there are
  read whatever they are called.
- **Nothing outside the store.** `..`, separators inside a name, and paths
  whose real place (symlinks followed) leaves the folder are refused. Hidden
  files (.DS_Store, desktop.ini) are not listed.
- **No size limit to speak of.** Qt 6.11 refuses request bodies over 32 MiB
  by default, and a project with its samples can be more: the server allows
  2 GiB. Qt 6.8 has no limit. 64 MB goes in and out in about a quarter of a
  second here.
- **The File view and the Soundfonts tab say where the files are**, and have
  a *Show folder* button, which opens the system's file manager there.
- **Earlier builds' projects come along.** On the first start with the store,
  whatever this profile's OPFS held is copied into the folder, once
  (`src/storage/carry-over.js`): projects with their folders, soundfonts with
  their notes, and keymaps. Nothing is deleted from OPFS, nothing in the
  folder is overwritten, and an unportable name is made portable
  (`bad:name?.taud` → `bad_name_.taud`). A banner says how many.
- **The earlier desktop app's projects come over at every start** (next
  section).
- Tested on Linux, in a scratch folder:
  - the copy;
  - every function through `opfs.js`;
  - names, the refusals (an encoded `..`, an unportable name, deleting or
    leaving the store) and 64 MB.

  The smoke test writes and reads back a 40 MB project, so CI checks the
  store with Qt 6.8 on the macOS runner, and on the Windows runner (which has
  no sound device: page and files only).

## The earlier desktop app's projects

The Tauri build (`../desktop`) kept projects, soundfonts and keymaps in its
webview's OPFS. At every start this one reads them where that webview left
them and copies them into `~/Microtone`, on a thread of its own while the
window comes up (`src/oldapp.cpp`, run by the file store). Nothing of the
earlier app's is changed.

| | webview | where | how it keeps OPFS |
|---|---|---|---|
| Linux | WebKitGTK | `~/.local/share/cc.microtone.desktop/storage/<salt>/<salt>/FileSystem` | plain files under their own names, beside an `origin` file (`tauri://localhost`) |
| macOS | WKWebView | `~/Library/WebKit/cc.microtone.desktop/…/FileSystem` | the same (untried: nobody here has a Mac with it) |
| Windows | WebView2 | `%LOCALAPPDATA%\cc.microtone.desktop\EBWebView\Default\File System` | numbered files (`000/t/00/00000001`); their names and folders in a LevelDB index (`Paths`), which origin is which folder in another (`Origins`: `http_tauri.localhost_0`) |

For Windows it reads LevelDB itself, a few hundred lines with nothing to
install: the manifest, the logs, the tables, and Snappy (Chromium compresses
the tables).

- **The same rules as the earlier app's own hand-over** (`desktop/src/
  handover.rs` and its glue), so the two can run in either order, or both. A
  file is created, or found already there with the same bytes (counted as
  done). A copy is replaced only while it is still exactly what was copied.
  Anything else goes beside the original name as "name (from the old app)":
  never over a file someone changed, and never a copy beside a copy.
- **A record per destination folder** (`<app data>/oldapp-copy.json`) keeps
  each file's size and time on both sides. An unchanged file is not looked
  at again, and one changed in the earlier app arrives on the next start.
  Nothing is deleted anywhere, and a file deleted from the folder comes back
  only if the earlier app changes it.
- Projects keep their folders; soundfonts and keymaps are flat, as the page
  keeps them. The soundfonts' notes are merged into `index.json`, what is
  already there winning. Names become portable (`bad:name?.taud` →
  `bad_name_.taud`), and Chromium's half-written `.crswap` files are skipped.
- **The page asks how it went** (`GET /api/files/oldapp`, while it says
  `running`), refreshes the File view, and the first time anything came over
  shows a banner (then `POST /api/files/oldapp?told`). The log says what was
  found and copied (`oldapp: …`).
- `MICROTONE_OLDAPP_DIR=<dir>` reads there instead (`none`: nowhere), and
  `MICROTONE_OLDAPP_ORIGIN` picks another origin than `tauri`.

`tools/oldapp-dump` (built beside the app) prints what it finds, copies it
into a folder of your choice with `--copy <dir>`, and dumps any LevelDB
database with `--leveldb <dir>`. Tested:

- `tools/oldapp-test.js` (CI, on both runners): the rules on a WebKit-shaped
  store (create, same, replace an untouched copy, beside, both copies edited,
  a folder in the way, names, the merged index, a dev server's origin
  ignored). With `--browser`, headless Chromium (on the Windows runner, Edge:
  WebView2's engine) keeps a store under `http://tauri.localhost`, renaming,
  overwriting, deleting, and churning until LevelDB writes a compressed
  table; the copy must match it file for file.
- The smoke test brings a small store over through the running app: the
  folder, the File view, the banner.
- On Linux, the real Tauri build's store (16 projects in folders), copied
  into a scratch folder: identical byte for byte.

## When it goes wrong: logs, crash reports, diagnostics

Nobody working on this has the Windows machines or the Macs it runs on, so
the app keeps its own account (`src/diagnostics.cpp`, `src/crashlog.c`), in
`<app data>/logs` (Windows: `%LOCALAPPDATA%\Microtone\Microtone\logs`):

- `microtone.log` is this run's messages, each with the time and the thread;
  `microtone.1.log` is the run before. The audio host logs every output it
  opens (what it asked for and what it got), every failure with its reason,
  every close, loss and reopen, and RtAudio's warnings.
- `crash-*.txt` is written if a run dies of a fault, an `abort()` or an
  uncaught C++ exception. It names the exception and the faulting module and
  offset, and gives the faulting thread's stack (on Windows unwound from the
  fault's own context). Where a `.pdb` is beside the module, the frames are
  named with file and line; the Windows build ships `microtone.pdb` for that.
  On Windows a minidump (`crash-*.dmp`) goes beside it.
- **The crash guard.** An output is marked as being opened, in the settings,
  until it has played for five seconds. A run that dies inside that window
  leaves the mark, and the next start skips that setting for the defaults.
  The Settings tab says so. After two such deaths in a row, it starts with Web
  Audio, and with native audio again the time after. So a remembered setting
  that kills the app cannot keep it from starting.
- **"Microtone diagnostics"** (Windows Start menu, `installer/diagnostics.cmd`)
  is for whoever has to report a failure. It plays test tones through every
  WASAPI mode and every ASIO driver with the probes. It then puts their output,
  a description of the computer, and the app's log and crash reports in a
  "Microtone report" folder on the Desktop, ready to send.

Tested here: the reporter under Wine (MinGW: a fault's frames named down to
the line, through Wine's dbghelp, which reads DWARF 4 but not 5) and on Linux
(signals, with backtraces); the guard on Linux, by killing the app inside the
window (defaults, then Web Audio, then native again); the diagnostics script
under Wine's cmd.

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
  - **The device list stays current.** The tab asks for a fresh one every
    time it is shown. The host also sends one unasked when the system says its
    devices changed, settled for 300 ms, and after a lost device is reopened:
    - macOS: Core Audio's device-list and default-output listeners;
    - Windows: an `IMMNotificationClient` (`mt_wasapi_watch` in `wasapi.c`).

    The link keeps the newest list (`link.devices`), and the tab redraws when
    it changes. A pushed list reuses the last ASIO list: probing ASIO loads
    every driver, and its driver list changes only when one is installed.
  - **"The default" follows the system's default output** on macOS and on
    Windows (WASAPI, any mode): headphones plugged in, or another device chosen
    in the Sound settings, reopen the stream on the new default. If its mode
    is not there, the defaults are tried.
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
    sample formats are the ones the hardware says it takes: 32-bit float,
    24-in-32, 24 or 32-bit PCM, 16-bit PCM (TPDF-dithered). Drivers refuse
    periods they never listed (a MOTU M2 gave `E_INVALIDARG` for everything
    but its default), so a refused period is followed by:
    - the same period in whole milliseconds;
    - the device's default period;
    - its minimum.

    Each period is tried in each of those formats, on a fresh client, with the
    buffer-alignment retry Windows asks for. The tab says when the device
    opened at another size than asked.

  Event-driven, on a thread of its own registered with MMCSS as "Pro Audio";
  everything COM about a stream happens on that thread. Devices are named by
  their endpoint ids, which stay the same between sessions. The device list
  gives each mode's limits per device, so the tab offers only rates and buffer
  sizes that will open, and disables a mode a device lacks. A first start
  tries low-latency shared, then shared.
  - `tools/wasapi-probe.c` (built beside the app on Windows) lists what WASAPI
    offers and plays a test tone through each mode. `wasapi-probe watch [s]`
    prints the system's device notifications as they come.
  - `wasapi_fake.c` stands in for it elsewhere (`-DMICROTONE_FAKE_WASAPI=ON`,
    testing only), so the host's WASAPI glue and the tab's modes can be tried
    on Linux. `MICROTONE_FAKE_WASAPI_LOSE_AFTER=<s>` makes a device go away,
    and `MICROTONE_FAKE_WASAPI_DEFAULT_AFTER=<s>` makes the other one the
    default.
  - Device notifications: under Wine the watch registers and unregisters
    cleanly, but Wine sends no notifications for PulseAudio's sinks coming and
    going. The host's side (follow the default, push the list) was tested on
    Linux with the stand-in, and the callbacks need a real Windows machine.
  - Checked under Wine 11 with the MinGW build of the probe:
    - enumeration (names, endpoint ids, mixer formats, low-latency ranges);
    - shared: 10 ms period, 200 callbacks in 2 s, no glitches, and the 440 Hz
      tone recorded off the sink at the right level;
    - low latency at 256 frames: 5.33 ms, 377 callbacks in 2 s;
    - Wine's own listed minimum is refused, and the default retry opens it;
    - exclusive: Wine offers none, and that refusal is reported.
  - On real Windows (2026-11-18): the CI build (MSVC, Qt 6.8.3, the
    windeployqt package) runs, and all three modes play as intended. A
    generic USB interface with ASIO4ALL works throughout.
  - A MOTU M2 (Windows 11 26H2) refused exclusive mode (`E_INVALIDARG`),
    allowed only 480 frames in low-latency shared mode, and crashed when the
    mode changed and on ASIO. Its owner sees the same in other programs, so
    the driver is the likely cause. The exclusive retries above came of it.
    If it still crashes, the crash report names the module it died in.
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
  - On real Windows (2026-11-18): the CI build plays through ASIO as intended.
    The tab's ASIO branch was first checked on Linux against a stubbed host
    (the driver's size, the limits, the window's button, and the switch from
    WASAPI asking for the driver's size).
- **Core Audio** (macOS): RtAudio's backend.
  - **"Automatic" keeps the device's rate.** Core Audio sets the device's own
    rate, for every app, when a stream asks for another. So rate 0 is the rate
    the system has the device at, and the engine's 48 kHz is converted to it.
    A rate picked in the tab changes the device, as Audio MIDI Setup does, and
    the tab says so. (Elsewhere rate 0 is 48 kHz where the device has it.)
  - **"The default" follows the system's default output.** On Apple silicon,
    plugging in headphones makes them another device. A listener on the
    default output device reopens the stream when the default is what is
    open.
  - Any reopen waits a quarter of a second first. Core Audio's "device gone"
    closes the stream on a notification thread of RtAudio's, and plugging
    something in can change the default more than once.
  - The callback runs on Core Audio's own I/O thread, which is already
    real-time.
- **`links`**: `docs.html` opens in the docs window, other pages of the app in
  the main window, `http(s):` and `mailto:` in the system browser. The window a
  link was clicked in never navigates away from an open project.

## The Windows installer

`installer/microtone.nsi` (NSIS 3, Unicode, English and Korean by Windows'
language):

- **For one person, with no administrator rights.** It installs into
  `%LOCALAPPDATA%\Programs\Microtone`, or wherever the last install went. It
  adds a Start menu shortcut, "Microtone diagnostics" beside it (above), a
  desktop one if asked on the last page, and an
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
- **The person's files stay.** Projects, soundfonts and keymaps in
  `%USERPROFILE%\Microtone` are never touched by an uninstall. Its first page
  says so, and asks whether to delete what the app keeps of its own too (off
  by default). If ticked, it removes `%LOCALAPPDATA%\Microtone\Microtone`
  (the browser profile, the logs, the autosave copies) and
  `HKCU\Software\Microtone\Microtone`.
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
- On real Windows (2026-11-18): install and uninstall work as intended.
- Not code-signed, so Windows SmartScreen warns about an unknown publisher.

## The macOS app

- **`Microtone.app`** has the bundle id `cc.microtone.desktop`, the Tauri
  build's. It is the same app, and the system keeps its grants (the
  microphone) by that id.
  - Dragged into Applications, it replaces the Tauri build's
    `Microtone.app`. The Tauri build's projects are not deleted (they are in
    WebKit's store), but the Qt build cannot see them until moving projects
    over is done.
- `macos/Info.plist.in`:
  - the version, macOS 12 as the floor, the Music category;
  - the text the system asks for the microphone with (the sampler's Record),
    in English and Korean (`macos/*.lproj`).
- **Where it keeps things:**
  - projects, soundfonts, keymaps: `~/Microtone` (not in Documents, which
    macOS would ask permission for);
  - the browser profile, logs and autosave copies:
    `~/Library/Application Support/Microtone/Microtone`;
  - the settings: `~/Library/Preferences/com.microtone.Microtone.plist`.
- **Signed ad hoc, not with a Developer ID, and not notarised.** An Apple
  silicon Mac runs nothing unsigned, so the ad hoc signature is the least it
  needs. Gatekeeper still refuses the first launch of a download: in System
  Settings → Privacy & Security, choose *Open Anyway*. Or, in Terminal:
  `xattr -dr com.apple.quarantine /Applications/Microtone.app`.
- The server listens on loopback only, so macOS's firewall never asks.
- CI's smoke test on `macos-latest` (Apple silicon, its virtual sound
  device): the page
  isolated with OPFS, Core Audio at 48 kHz, 256 frames, and 480 000 frames of
  Eighth bit-identical to the WebAssembly engine. So Apple's compiler and libm
  give the same bits.
- On a real Mac (2026-11-18, an older MacBook Air):
  - it plays;
  - following the default output works (AirPods connected);
  - a 64-frame buffer is now and then over budget, as that machine would be.

  The Settings tab's device list did not refresh then. It does now (above),
  confirmed on the same machine.
  Still to try:
  - the native audio and the Settings tab (Core Audio's devices and rates;
    headphones in and out while playing);
  - copy and paste in text fields (⌘C, ⌘V, ⌘A). A Qt bug report,
    QTBUG-85050, had ⌘V and ⌘A failing in Qt WebEngine's editable fields on
    macOS (Qt 5.15). An Edit menu with those shortcuts is not the fix: it
    would take them from the tracker's own copy and paste;
  - the sampler's Record (the microphone prompt);
  - closing with an unsaved project (⌘Q as well as the window's button).

## Not yet done

- Online projects (sign-in through the system browser, the access token, the
  `/api/online` proxy). The page's requests already reach this server, which
  answers them 404 for now.
- The updater and the deep-link scheme. The installer already takes `/P /R`,
  the switches an updater runs it with.
- Linux packaging (AppImage, .deb/.rpm) and its CI.
- Code signing (a Windows certificate; Apple's Developer ID and
  notarisation), and the third-party notices a release must ship (Qt and
  Chromium's licences, RtAudio's, the ASIO SDK's).
- Moving projects over from the Tauri build is done from both sides: this
  build reads the Tauri build's storage itself ("The earlier desktop app's
  projects"), and a Tauri release carrying `desktop/src/handover.rs` copies
  them too while that app is still used. The WebView2 reader has run only on
  Chromium and Edge profiles, not yet on a real Tauri install on Windows;
  the macOS path is untried.
- The native audio host's next steps:
  - JACK on Linux; device notifications on Linux (PulseAudio's own stream
    already follows the default sink; the tab's list catches up when shown);
  - audio input for the sampler's Record, and MIDI;
  - whether PulseAudio's simple API reports underflows at all (RtAudio's
    status flag): the 0 above may mean "none", or "not reported".
