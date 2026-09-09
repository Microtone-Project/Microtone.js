# Microtone.js

![Microtone screenshot](Screenshot1.png)

A web build of the **Microtone** tracker and the **Taud** audio engine from
[TSVM](https://github.com/curioustorvald/tsvm). Two halves:

- **Taud engine** (`src/engine/`) — a faithful JavaScript translation of the
  tracker engine in TSVM's `AudioAdapter.kt`, running inside an AudioWorklet.
  Pure computation, no DOM/Web Audio imports, so the same code runs headlessly
  under Node for conformance testing against the JVM engine.
- **Microtone tracker** (`src/ui/`) — a native web rewrite of the tracker UI
  (the TSVM `taut.js` is the behavioural reference).

## Try it

Simply visit **[microtone.cc](https://microtone.cc)** and start tracking; no strings attached.
  
## Running locally

No build step. Serve the directory with any static file server:

```sh
npm run serve            # python3 -m http.server 8737
# then open http://localhost:8737/            (tracker)
#           http://localhost:8737/player.html (minimal player)
```

## taudplay

`src/taudplay/` is a standalone **player** library built out of the same engine:
a transport, one fader per voice, and two probes per voice (current volume and
pan), for pages and games that want to *play* a .taud rather than edit one.
`player.html` is its reference consumer. Regenerate the separate LGPL-3.0 repo
(and the committed single-file worklet the fallback path loads) with:

```sh
node tools/make-taudplay.js [outDir]   # default ../../../microtone-taudplay (a sibling checkout)
```

The engine there is a copy of this one, so **re-run it after any engine
change** — otherwise the library and the tracker stop agreeing about what a
song sounds like. Its own suite (`test/taudplay/`) travels with it and asserts
exactly that.

## Testing

Requires Node ≥ 22.

```sh
node --test        # discovers test/node/*.test.js and test/taudplay/*.test.js
```

Browser smoke pages under `test/browser/` are driven headlessly over CDP:

```sh
node tools/browser-smoke.js test/browser/taudplay-smoke.html
```

Engine conformance is verified against PCM dumps rendered by the real JVM
engine (`tsvm/devtests/webconf/`) over the corpus in `test/corpus/`:

```sh
node tools/render-taud.js test/corpus/WHEN.taud out.pcm
node tools/compare-pcm.js out.pcm reference.pcm
```

## Layout

| Path | Contents |
|---|---|
| `src/engine/` | Taud engine port (worklet- and Node-safe, no imports outside itself) |
| `src/format/` | .taud/.tsii/.tpif parser + serialiser (gzip/zstd via `vendor/`) |
| `src/worklet/` | AudioWorkletProcessor + message protocol |
| `src/taudplay/` | the standalone player library (see above) |
| `src/audio/` | main-thread audio system (context lifecycle, snapshots) |
| `src/doc/` | canonical document model, invertible ops, undo, worklet sync |
| `src/ui/` | tracker application (vanilla ES modules, canvas + DOM) |
| `src/storage/` | OPFS virtual disk, import/export |
| `vendor/` | vendored single-file ESM deps (see `vendor/VENDOR-VERSIONS.md`) |
| `test/corpus/` | .taud conformance/demo corpus (from the TSVM repo) |
| `test/fixtures/` | file formats built rather than committed (the .ims/.bnk pair) |
| `tools/` | Node CLIs: render, compare, inspect, worklet-bundle, taudplay, browser tests |

## Provenance

Engine port keeps the Kotlin function/field names (`applyTrackerRow`,
`triggerNote`, `resolveActiveEnvelopes`, …) so future syncs against
`tsvm/tsvm_core/src/net/torvald/tsvm/peripheral/AudioAdapter.kt` diff cleanly.
Format reference: `tsvm/terranmon.txt` §"Taud serialisation format";
effect semantics: `tsvm/TAUD_NOTE_EFFECTS.md`.

Two banks ship with the app so an import can sound without the user hunting for
one: `assets/GeneralUser-GS.taud.sf2.gz` (GeneralUser GS, for MIDI) and
`assets/STANDARD.BNK.gz` (the general AdLib instrument bank the Iyagi Music
Sound corpus resolves its patch names against, for `.ims`). Neither is used
unless an import asks for it.

## Copyright

Copyright (C) 2026 CuriousTorvald

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
