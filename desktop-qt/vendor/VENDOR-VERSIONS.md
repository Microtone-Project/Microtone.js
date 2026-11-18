# Vendored code (desktop-qt)

Copied verbatim from a release; never edited here. Update by copying a newer
release over the files and changing this record.

## RtAudio 6.0.1 — `rtaudio/`

- Source: https://github.com/thestk/rtaudio, tag `6.0.1`
  (`https://github.com/thestk/rtaudio/archive/refs/tags/6.0.1.tar.gz`,
  sha256 `7206c8b6cee43b474f43d64988fefaadfdcfc4264ed38d8de5f5d0e6ddb0a123`).
- Files: `RtAudio.h`, `RtAudio.cpp`, `LICENSE` (MIT-style; its request to send
  changes upstream is explicitly not binding).
  - `RtAudio.h`   sha256 `3acbd6d0493a1d03941be3f22e050d0fe9ab4a968784c7d0c81530a58162953d`
  - `RtAudio.cpp` sha256 `d880f065bdb65536ce5cf4619b6a2408a360ad0103b8b38600f1a29a11ff1e1e`
- Backends are chosen by CMakeLists.txt: ALSA, PulseAudio and JACK (when
  found) on Linux, CoreAudio on macOS. On Windows none yet: WASAPI is the
  app's own (`src/wasapi.c`, for exclusive mode, which RtAudio's lacks), and
  RtAudio stays for ASIO.
- ASIO (Windows) needs the release's `include/asio*.{h,cpp}`,
  `iasiothiscallresolver.*` and `ginclude.h` (Steinberg's SDK files, GPLv3 since
  October 2025), which come in with the Windows build.
