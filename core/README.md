# core — what every Microtone app shares

Plain ES modules with no build step and no dependencies beyond what is vendored
in `vendor/`: two decompressors and the Zstandard encoder saves use. Nothing here imports from outside `core/`, and
nothing here knows which app is using it.

| Path | Contents |
|---|---|
| `engine/` | The Taud engine — the reference implementation (TSVM's `AudioAdapter.kt` follows it). Pure computation: importable by a Worker, an AudioWorklet and Node alike |
| `worklet/` | The AudioWorkletProcessor, the engine command protocol, and the committed single-file bundle for worklets that cannot import modules |
| `audio/` | The live audio system (context, worklet or render Worker, snapshots), its SharedArrayBuffer ring, the resampler, and offline rendering (`loadIntoEngine`, the one upload sequence every host uses) |
| `format/` | `.taud` / `.tsii` / `.tpif` parse and write, section codecs (saves compress with Zstandard in a worker, `zstd.js`), the name-escape convention |
| `tuning/` | The pitch-table presets every notation is drawn from |
| `storage/` | The online-projects client (the server is `microtone-worker/server/`) |
| `vendor/` | fflate and fzstd, single-file ESM, and zstd's encoder as WebAssembly in an ES module (see `vendor/VENDOR-VERSIONS.md`) |

## How the apps reach it

`microtone-worker/core` and `microtone-touch-worker/core` are committed symlinks
to `../core`. A static server run inside either app follows the link, and so
does Node, so both run and test straight from their own directories. An app
imports `core` by a relative path through the link
(`../../core/engine/engine.js` from `microtone-worker/src/ui/`), which is also
the path the browser sees.

Nothing that SHIPS an app follows the link: Cloudflare's asset upload does not
reliably, and a Windows checkout turns the link into a text file. So shipping
goes through `tools/stage-site.js`, which copies the app with `core/` laid in
as real files — the `[build]` step in `/wrangler.toml` for microtone.cc and
`desktop/tools/stage-frontend.js` for the desktop app.

## Rules

- The engine rules in the project instructions apply to `engine/` unchanged:
  the golden gate (`microtone-worker/test/node/engine-golden.test.js`), no
  `Math.random` outside `engine/rng.js`, a Float32 mix bus, and no imports from
  `vendor/` or anything DOM- or Web-Audio-touching.
- After any change under `engine/`, `worklet/`, `audio/` or `format/`, rebuild
  `worklet/taud-processor.bundle.js` (`node tools/make-worklet-bundle.js`, from
  `microtone-worker/`) and taudplay (`node tools/make-taudplay.js`).
- The tests and tools for this code still live in `microtone-worker/test/` and
  `microtone-worker/tools/`.
