# Vendored dependencies

Single-file, dependency-free ES modules. Never imported by `core/engine/` or the
worklet — compression is a load/save-time concern only.

| File | Package | Version | Source URL | Role |
|---|---|---|---|---|
| `fflate.esm.js` | fflate | 0.8.2 | https://unpkg.com/fflate@0.8.2/esm/browser.js | gzip inflate (load) + deflate (`toBytes()`, the in-memory byte view; desktop TSVM auto-detects gzip vs zstd by magic) |
| `fzstd.esm.js` | fzstd | 0.1.1 | https://unpkg.com/fzstd@0.1.1/esm/index.mjs | zstd decompress (load path; TSVM's "gzip" namespace actually writes zstd frames) |
| `zstd-compress.wasm.js` | Zstandard (BSD-3-Clause) | 1.5.7 | https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz | zstd COMPRESS, for saves: built here, see below |

To update fflate or fzstd: re-download from the URL, bump this table, run `node --test test/node/` from `microtone-worker/`.

## zstd-compress.wasm.js — built here, not downloaded

There was no usable third-party build. `@oneidentity/zstd-js` 1.0.3, the
obvious candidate, writes broken frames: its stream encoder never ends a frame
whose input is a whole number of 128 KiB blocks — which every sample/instrument
image is (8 650 752 bytes = 66 of them) — and its one-shot encoder compresses
18 bytes of uninitialised memory after the input. So this is upstream zstd's
own `lib/common` + `lib/compress`, compiled to WebAssembly with an
eight-function shim (`microtone-worker/tools/zstd-wasm.c`) and base64'd into an
ES module. It imports nothing; `core/format/zstd.js` loads it, in the save
worker (`core/format/zstd.worker.js`) or, where there is no Worker, on the
calling thread. It compresses two ways, and each is byte-identical to native
libzstd 1.5.7 at the same level (checked against Python's `zstandard` on the
corpus images and pattern bins): one-shot (autosave) matches `compress()`, and
streamed in 256 KiB steps (a manual save, which shows its progress) matches
`compressobj(size=n)` fed the same steps and ended by an empty flush. At level
19 the two differ by under a tenth of a percent, either way.

| Input | Version | Source | sha256 |
|---|---|---|---|
| Zstandard source | 1.5.7 | https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz | `eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3` |
| wasi-sdk (clang 23.1.0) | 34.0 | https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz | `b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4` |

To rebuild (only for a zstd or wasi-sdk upgrade): unpack both, then from
`microtone-worker/` run `node tools/make-zstd-wasm.js <wasi-sdk dir> <zstd dir>`.
The tool refuses a module that imports anything or does not round-trip through
fzstd, and writes the wasm's size and sha256 into the module's header; the same
inputs give the same bytes, wherever they are unpacked. Then bump this table and
run `node --test test/node/zstd.test.js` and
`node tools/browser-smoke.js test/browser/zstd-smoke.html 120`.
