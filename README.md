# Microtone.js

![Microtone screenshot](Screenshot1.png)

**Microtone** is a music tracker for the notes a piano cannot play. Every pitch
sits on a grid of 4096 steps per octave, so 12-TET, 19-TET, 31-TET,
Bohlen–Pierce and a temperament you drew yourself are all the same kind of thing
to it. Sources can be placed anywhere on the sphere and delivered as ambisonic
B-format as readily as stereo. It runs in a browser tab, and that is the entire
install.

## Try it

Simply visit **[microtone.cc](https://microtone.cc)** and start tracking; no
strings attached. There is no account and no server side — projects live in your
browser's private storage, and even MIDI and module conversion happens on your
own machine. Three demo songs sit on the welcome screen if you would rather hear
it before writing anything, the **?** button opens the keyboard reference, and
the [full manual](https://microtone.cc/docs.html) is inside the app.

Rather have it as an application? Microtone for Linux, Windows and macOS is on
the [releases page](https://github.com/Microtone-Project/Microtone.js/releases):
the same tracker in a window of its own, working offline and keeping itself up
to date.

### What it does

- **Any tuning, not just the twelve.** Pick a notation preset — 12, 19, 24, 31,
  41-TET (with Kite glyphs), Shi'er lü, Bohlen–Pierce — or draw your own in the
  Notation Maker, and the editor snaps entry, display and stepping to its
  degrees. Retune a whole song between tunings without rewriting it.
- **Opens what you already have.** `.taud` is the native project; `.mod`,
  `.s3m`, `.xm`, `.it`, `.mon` and AdLib `.ims` are converted on the fly, and
  **Import MIDI…** renders a `.mid` through a SoundFont. A General MIDI bank and
  an AdLib bank ship with the app, so an import sounds without you hunting for
  one first.
- **Space, not merely width.** A song chooses stereo, planar 360° or the full
  sphere, and the pan column carries a real angle. Export stereo, quadraphonic,
  5.1, 7.1 or ambisonic B-format (first to third order, AmbiX with ADM
  metadata) — or stems, one mono WAV per track in a single ZIP.
- **Master it in the same window.** Trim, high-pass, EQ, compressor and limiter,
  with loudness, true-peak, crest and gain-reduction metering, and an offline
  analysis of the whole song. The chain you hear is the chain the export
  renders through.
- **Instruments that are more than samples.** Envelopes, filters, panning and
  note-stealing rules per instrument, plus metainstruments — a *Layered* kit
  that sounds several instruments side by side, or an *FM Rack* that wires them
  into one another.
- **Your keyboard becomes the instrument.** Forty keys laid out as an isomorphic
  lattice — Bosanquet–Wilson, Wicki–Hayden, Harmonic Table and more — fitted to
  whatever tuning the song is in.

## A look around

![](Screenshot2.png)

**Cues** are the song's order list. A Taud pattern belongs to a single channel,
so every voice gets its own column and its own pattern number on every row: the
bassline can hold for sixteen cues while the lead changes on each one. The two
command columns on the left carry the flow — jump, halt, cue length — and a
whole run of them can be filled in one step.

![](Screenshot3.png)

The **pattern editor** puts several patterns side by side, which is how you write
against something that already exists: keep the part you are answering in view,
copy a phrase out of one column and into the next, or edit two voices of the
same passage without losing your place in either.

![](Screenshot4.png)

The **sample bin**, mid-song. The orange in this waveform is Invert Loop
(`S $F0xx`) at work — the effect walks through the loop region flipping one
byte at a time, and every byte it has touched so far is tinted live as the song
plays. Nothing is written to the file: stop the transport and the sample is
exactly as it was.

![](Screenshot5.png)

The **instrument editor** is the main work panel. Each instrument is a sample
plus its volume, panning, filter, vibrato and note-stealing behaviour; the
tabs above carry its envelopes and its zone map. The badges in the list say
where an instrument came from — `META` for a metainstrument, `IXMP` for a
SoundFont patch and the number of pitch × velocity zones it brought with it.

![](Screenshot6.png)

The **mastering tab**, metering a song as it plays. Microtone lets you write and
master the piece in one application: the rack down the left is the delivery
chain, the meters on the right are the ones a mastering engineer asks for —
short-term and integrated loudness, loudness range, true peak, crest against its
allpassed twin — and the same chain is what an export renders through.

![](Screenshot7.png)

The **project tab** holds everything about the piece that is not a note: tempo
and meter, global and mixing volume, the tuning reference and its frequency, the
panning model, the display notation, and the message that travels inside the
file. Housekeeping tools for the whole project live at the bottom of it.

![](Screenshot8.png)

The **keymap tab** turns a computer keyboard into a 40-key isomorphic
microtonal instrument. This is Bosanquet–Wilson fitted to 19-TET: all nineteen
degrees fall under the fingers, each cap says what it plays in the song's own
notation and how far that is from 12-TET, and the colour bands repeating across
the board *are* the isomorphism. Layouts are yours rather than the song's — they
travel as `.taudkey` files — but a piece that needs a particular one can carry a
copy of it.

## Just the player — `taudplay`

**If you are here for the playback module rather than the tracker, simply run
`npm i taudplay`.** No tracker attached.

`taudplay` is the playback half of this engine as a standalone LGPL-3.0 library,
for pages and games that want to *play* a `.taud` rather than edit one. A file
rendered there is bit-identical to the same file rendered in the tracker. Its
whole surface is a transport, **one fader per voice**, **two probes per voice**
(how loud that channel is right now, and where it sits) and the sixteen
**interrupts** the song itself fires in time with the music:

```js
import { TaudPlayer } from "taudplay";

const player = await new TaudPlayer().init();
await player.load(await (await fetch("theme.taud")).arrayBuffer());
button.onclick = async () => { await player.resume(); player.play(); };

player.setVoiceGain(LEAD, 0.0, 1200);        // duck the lead over 1.2 s
player.setInterrupt(0, (n) => spawnEnemy(n)); // let the song cue the game
```

That is the point of it. A game does not want a pattern editor; it wants to duck
the lead when the player enters a cave and bring the drums up in combat. A
tracker song is 32 or 64 channels that were *written together*, so fading them
against each other gives you contextual scoring for the cost of one file.

`player.html` in this repository is its reference consumer.

---

# For developers

Four parts live here:

- **`core/`** — what every Microtone app shares. Above all the **Taud engine**
  (`core/engine/`), the reference implementation of the Taud engine (TSVM's
  `AudioAdapter.kt` follows it), running in a render Worker or an AudioWorklet.
  Pure computation, no DOM/Web Audio imports, so the same code runs headlessly
  under Node, where a golden gate pins its renders bit for bit. Beside it: the
  file format, the live audio system, offline rendering, the pitch tables and
  the online-projects client.
- **`microtone-worker/`** — the Microtone tracker, a native web rewrite of the
  tracker UI (the TSVM `taut.js` is the behavioural reference), and the
  microtone.cc site it is served as.
- **`microtone-touch-worker/`** — Microtone Touch, a phone sketchpad built
  around an isomorphic keyboard (a prototype), with its own version number.
- **`desktop/`** — the tracker as a desktop application.

Each web app reaches `core/` through a committed `core → ../core` symlink, so
either one runs straight from its own directory with no build step. What ships
is a staged copy with the link replaced by the files (`tools/stage-site.js`,
run by the Cloudflare deploy and the desktop build alike).

## Running locally

No build step. Serve the directory with any static file server:

```sh
cd microtone-worker
npm run serve            # python3 -m http.server 8737
# then open http://localhost:8737/            (tracker)
#           http://localhost:8737/player.html (minimal player)

cd microtone-touch-worker
npm run serve            # python3 -m http.server 8738 — Microtone Touch
```

## Desktop app

`desktop/`, beside `microtone-worker/` rather than in it, wraps the site in a
[Tauri 2](https://v2.tauri.app/) window with self-updating releases. Building it,
releasing it (raise the version in `microtone-worker/package.json`) and what the
shell does for the page are in [`desktop/README.md`](desktop/README.md).

## Testing

Requires Node ≥ 22.

```sh
cd microtone-worker && node --test        # test/node/*.test.js and test/taudplay/*.test.js
cd microtone-touch-worker && node --test  # Touch's own suite
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

## Screenshots

The screenshots in this README (`Screenshot1..8.png`, the first doubling as
`microtone-worker/screenshot.png`, the site's preview image) and Microtone
Touch's (`microtone-touch-worker/screenshots/`) are generated, in headless
Chromium, from scenes in `microtone-worker/tools/shots/`:

```sh
cd microtone-worker
node tools/make-screenshots.js            # the tracker's eight (needs test/corpus/)
node tools/make-screenshots.js 4          # just one of them
node tools/make-screenshots.js touch      # Touch's six
node tools/make-screenshots.js --out /tmp/shots   # look before replacing
```

Shots with a song playing are taken in real time, so each run is the same scene
but not the same pixels: look before committing.

## Online projects (server)

The File tab can keep a few working projects with a person's SceneID account.
microtone.cc is the Cloudflare Worker `microtone`: `microtone-worker/` and the
`core/` it links to are published as static files, and the Worker's code
(`server/worker.js`) runs only for a request no file matches — the API under
`/api/online`, handled by `server/online/`, which keeps the index in D1
(`migrations/`) and the bytes in R2. Its configuration is `wrangler.toml` at the
repository root, because the build deploys from there; its `[build]` step stages
the site into `build/microtone-worker`, which is what is uploaded, and the server
code and schema stay out of the published files through `.assetsignore`.
There are no R2 or D1 keys anywhere, because a binding is the permission.
Sign-in is [SceneID](https://id.scene.org/docs/) OAuth
(`server/online/sceneid.js`); its client id and secret are Worker secrets
(`npx wrangler secret put`) and live in `.dev.vars` beside `wrangler.toml`
locally — never in a committed file, since everything tracked here is public.
SceneID only sends people back to registered callbacks, so every origin that
signs in needs `<origin>/api/online/auth/callback` registered with SceneID.

The desktop app (`desktop/`) signs in through the system's browser instead of a
pop-up (`server/online/desktop.js`): its sign-in runs on this site as usual, then
hands the app a one-time code through the app's `cc.microtone.desktop:` scheme,
which the app swaps — with a PKCE verifier only it holds — for an access token it
sends as `Authorization: Bearer`. The codes live in the `desktop_codes` table
(`migrations/0002_desktop_codes.sql`), so a deploy that adds it needs
`npx wrangler d1 migrations apply microtone-online --remote` once.

Wherever there is no API (a static server, `npm run serve`) the online section
simply does not appear. To run it locally — from the REPOSITORY ROOT, with a
test sign-in standing in for SceneID (or put `SCENEID_CLIENT_ID` and
`SCENEID_CLIENT_SECRET` in `.dev.vars` instead; `http://localhost:8788` is a
registered callback):

```sh
printf 'ONLINE_DEV_LOGIN=1\n' > .dev.vars
npx wrangler d1 migrations apply microtone-online --local
npx wrangler dev --port 8788    # http://localhost:8788/
```

`test/node/online-*.test.js` run the same server code under Node, against a
real SQLite loaded from `migrations/` and an in-memory R2.

## Regenerating taudplay

`src/taudplay/` is authored here; the standalone LGPL-3.0 repository is a
generated artefact carrying a verbatim copy of the engine. Rebuild it — and the
committed single-file worklet the non-module-worklet fallback loads — with:

```sh
node tools/make-taudplay.js [outDir]   # default ../../../microtone-taudplay (a sibling checkout)
```

The engine there is a copy of this one, so **re-run it after any engine
change** — otherwise the library and the tracker stop agreeing about what a
song sounds like. Its own suite (`test/taudplay/`) travels with it and asserts
exactly that.

## Layout

Paths in `microtone-worker/`, and the `core/` beside it:

| Path | Contents |
|---|---|
| `../core/engine/` | Taud engine port (worklet- and Node-safe, no imports outside itself) |
| `../core/format/` | .taud/.tsii/.tpif parser + serialiser (gzip/zstd via `core/vendor/`) |
| `../core/worklet/` | AudioWorkletProcessor + message protocol |
| `../core/audio/` | the live audio system (context lifecycle, snapshots) and offline rendering |
| `../core/tuning/` | the pitch tables every notation is drawn from |
| `src/taudplay/` | the standalone player library (see above) |
| `src/audio/` | stem, surround and mastering-analysis exports |
| `src/doc/` | canonical document model, invertible ops, undo, worklet sync |
| `src/ui/` | tracker application (vanilla ES modules, canvas + DOM) |
| `src/storage/` | OPFS virtual disk, import/export (the online projects client is `../core/storage/`) |
| `server/` | the microtone Worker: the online projects API (not published — `.assetsignore`) |
| `migrations/` | its D1 schema |
| `vendor/` | the import runtime and converters (see `vendor/VENDOR-VERSIONS.md`) |
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
