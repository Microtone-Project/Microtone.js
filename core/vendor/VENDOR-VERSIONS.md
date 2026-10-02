# Vendored dependencies

Single-file, dependency-free ES modules. Never imported by `core/engine/` or the
worklet — compression is a load/save-time (main thread) concern only.

| File | Package | Version | Source URL | Role |
|---|---|---|---|---|
| `fflate.esm.js` | fflate | 0.8.2 | https://unpkg.com/fflate@0.8.2/esm/browser.js | gzip inflate (load) + deflate (save path; desktop TSVM auto-detects gzip vs zstd by magic) |
| `fzstd.esm.js` | fzstd | 0.1.1 | https://unpkg.com/fzstd@0.1.1/esm/index.mjs | zstd decompress (load path; TSVM's "gzip" namespace actually writes zstd frames) |

To update: re-download from the URL, bump this table, run `node --test test/node/` from `microtone-worker/`.

