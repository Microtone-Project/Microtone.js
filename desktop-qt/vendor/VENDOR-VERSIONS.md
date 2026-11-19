# Vendored code (desktop-qt)

Copied verbatim from a release; never edited here — except RtAudio's ASIO
section, which carries two small patches recorded below (a driver filter; a
non-null bufferSwitchTimeInfo). Update by copying a newer release over the
files, re-applying those patches, and changing this record.

## RtAudio 6.0.1 — `rtaudio/`

- Source: https://github.com/thestk/rtaudio, tag `6.0.1`
  (`https://github.com/thestk/rtaudio/archive/refs/tags/6.0.1.tar.gz`,
  sha256 `7206c8b6cee43b474f43d64988fefaadfdcfc4264ed38d8de5f5d0e6ddb0a123`).
- Files: `RtAudio.h`, `RtAudio.cpp`, `LICENSE` (MIT-style; its request to send
  changes upstream is explicitly not binding).
  - `RtAudio.h`   sha256 `3acbd6d0493a1d03941be3f22e050d0fe9ab4a968784c7d0c81530a58162953d`
  - `RtAudio.cpp` sha256 `d880f065bdb65536ce5cf4619b6a2408a360ad0103b8b38600f1a29a11ff1e1e` (as released; patched since, below)
- Backends are chosen by CMakeLists.txt: ALSA, PulseAudio and JACK (when
  found) on Linux, CoreAudio on macOS, ASIO on Windows. WASAPI is the app's
  own (`src/wasapi.c`, for exclusive mode, which RtAudio's lacks).

### Patch 1: an ASIO driver filter (2026-11-19, TODO 349)

RtAudio loads EVERY installed ASIO driver into the process just to list them
(`RtApiAsio::probeDevices` → `probeDeviceInfo` → `loadDriver`, `ASIOInit`),
from a `static AsioDrivers drivers` list nothing outside RtAudio.cpp can
reach — so a driver that crashes (Cubase's "Generic Low Latency ASIO Driver"
did, 2026-11-19) would take the app down by being listed, and the app could
not keep it out. The patch adds a filter the host sets; a refused driver is
neither listed nor loaded. The app (`src/asiocheck.cpp`) refuses drivers its
blocklist names and those that crashed or hung when `asio-probe check` tried
them in a process of their own. Five lines, ASCII, marked `MICROTONE PATCH`:

```diff
 static AsioDrivers drivers;
+// MICROTONE PATCH (desktop-qt/vendor/VENDOR-VERSIONS.md): the host may refuse
+// a driver before it is loaded: one that crashed or hung when tried in a
+// process of its own. Refused drivers are not listed, and never loaded here.
+bool (*rtaudio_asio_driver_allowed)( const char *name ) = 0;
 static ASIOCallbacks asioCallbacks;
@@ RtApiAsio :: probeDevices
       continue;
     }
+    if ( rtaudio_asio_driver_allowed && !rtaudio_asio_driver_allowed( tmp ) ) continue; // MICROTONE PATCH
     driverNames.push_back( tmp );
```

### Patch 2: a bufferSwitchTimeInfo that forwards (2026-11-20)

RtAudio registers ASIO's 2.0 callback `bufferSwitchTimeInfo` as NULL and tells
drivers it does not use it (`kAsioSupportsTimeInfo` answers 0). A driver may
call it regardless — and jumps to address 0. Cubase's "Generic Low Latency
ASIO Driver" (asioglld.dll) did: the friend's minidump of 2026-11-19, the
exception at RIP 0 called from inside the driver. Now it forwards to
`bufferSwitch` and returns NULL, as Steinberg's own sample host does; what
RtAudio tells drivers is unchanged. Marked `MICROTONE PATCH`:

```diff
@@ after static void bufferSwitch( long index, ASIOBool /*processNow*/ ) { … }
+// MICROTONE PATCH (desktop-qt/vendor/VENDOR-VERSIONS.md): the ASIO 2.0
+// callback, forwarding to bufferSwitch. …
+static ASIOTime *bufferSwitchTimeInfo( ASIOTime * /*timeInfo*/, long index, ASIOBool processNow )
+{
+  bufferSwitch( index, processNow );
+  return NULL;
+}
@@ RtApiAsio :: probeDeviceOpen
-  asioCallbacks.bufferSwitchTimeInfo = NULL;
+  asioCallbacks.bufferSwitchTimeInfo = &bufferSwitchTimeInfo; // MICROTONE PATCH (was NULL)
```

Checked here only against the SDK headers (clang, MinGW target: the
prototype is asio.h's); the build is CI's MSVC, the proof a driver that
calls it.

`RtAudio.cpp` as patched (both): sha256
`84876e8a5bcb0514f89a245d52bc7091fcf6ba4b69891a158a74febc13757088` (the
release's is below).

### `rtaudio/include/` — the ASIO SDK files, as the same release ships them

Steinberg's ASIO SDK 2.3 files (`asio.{h,cpp}`, `asiodrivers.*`, `asiodrvr.h`,
`asiolist.*`, `asiosys.h`, `ginclude.h`, `iasiodrv.h`; `asiolist.cpp` and
`asiodrivers.*` with RtAudio's small changes) plus `iasiothiscallresolver.*`
(Fraser Adams' shim for compilers without MSVC's thiscall; inert on x64) and
the release's `asioinfo.txt`. Only the Windows build compiles them. Not copied:
the release's `dsound.h`, `soundcard.h` and `functiondiscoverykeys_devpkey.h`
(other backends').

Licence: since 15 October 2025 Steinberg offers the ASIO SDK under the GNU GPL
version 3 beside its proprietary licence, and Microtone (GPL-3.0-or-later)
takes it under the GPL — so a Windows binary with ASIO is distributed under
GPLv3. A proprietary licensee of Microtone needs Steinberg's own licence for
ASIO (third-party components are outside Microtone's proprietary licence).
For the cleanest record, these files can be replaced by the same files from
Steinberg's own GPLv3 download (sdk.steinberg.net); the names match.

| file | sha256 |
|---|---|
| `asio.cpp` | `f1cc1b4a70c3639ff336a688452b3ca52843f054a6ebdd13be421d338c2db440` |
| `asio.h` | `5f965d98bc6592861720ca59bd0090579c402632ecaeb4bb245d1aab2e819ce4` |
| `asiodrivers.cpp` | `9aa61bdbbf3a03802c42bce66e318ec7a34161f40eb2ec139a5fbcc7e6f8203e` |
| `asiodrivers.h` | `4b4606d5d8865f17514df70b97f9fd7bba4fb104ecd3e7a082abbb40ad019e64` |
| `asiodrvr.h` | `899cba50d429461c87bdf4dde88bc0768fbffcbad2e41c44a94fcf5167da88cb` |
| `asioinfo.txt` | `a0b0f2c869fe994d4346be3cce53e93fe53d7b97449c91b823539b8cd65d4792` |
| `asiolist.cpp` | `317098b52a8002835c8c96bbdc2cb78e051afad1fc9dc95d955b297364077b0a` |
| `asiolist.h` | `005a9a23fbee9b1d98ed0ffdde60773befd3a5cad8e692fac761f71d9025bdae` |
| `asiosys.h` | `00f406f6733b1f1c144c140e9915f3ceaea76598adb7c2b1f2378c343ab00228` |
| `ginclude.h` | `3b5bf699d62291131b84ecb2ea73b444e7e0de8d9f754c30a1e323af129b6762` |
| `iasiodrv.h` | `861f110bc7cf0756ee10e0ea4d57e2964f8d8359cd6c9483d8b47785bcc9e79c` |
| `iasiothiscallresolver.cpp` | `1110eaa016c4b781dcb2ec5800fdbf94354e40c240cb62b01f3332906eafada1` |
| `iasiothiscallresolver.h` | `9c4c229356003af61dbf191bcfe2140d7eab9b8d090d3ffbe879155fe040c807` |

## Monocypher 4.0.2 — `monocypher/`

- Source: https://monocypher.org/download/monocypher-4.0.2.tar.gz, sha512
  `bf275d4c53ff94af6cdc723a4e002e9f080f4d1436c86c76bb37870b34807f1d7b32331d8ff8a1aeb369e946f3769021e03e63efac25b82efc5abf54dc084714`
  (as published beside it at https://monocypher.org/download/).
- Files: `src/monocypher.{c,h}`, `src/optional/monocypher-ed25519.{c,h}`
  (Ed25519 with SHA-512, which minisign uses; Monocypher's own EdDSA hashes
  with BLAKE2b), `LICENCE.md` (CC0-1.0, or BSD-2-Clause at the user's choice).
  - `monocypher.c`         sha256 `afe2b098c8569577a84488e0b98d276d1fba6506adea68bb9241a52111734c59`
  - `monocypher.h`         sha256 `f78bb31255cfb7beba66afd2137f5194c8a025cf40488b6cc1e295234d43f374`
  - `monocypher-ed25519.c` sha256 `7c9b16056cbd27521919e8a6f56a228808b9e718afc42e3d33f28c08e5abdee2`
  - `monocypher-ed25519.h` sha256 `bd546edcd468d64e28caa3dbf4b1d6bfad7435c0ce994723fd81aae26405121b`
- Used by `src/minisign.cpp` only: checking an update's signature (BLAKE2b-512
  of the file, then Ed25519), the updater key being the Tauri build's.
