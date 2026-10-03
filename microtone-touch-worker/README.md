# Microtone Touch

A phone sketchpad for the notes a piano cannot play: an isomorphic keyboard in
4- to 53-tone equal temperaments, Bohlen–Pierce, or Shi'er lü at the Chinese
a-ak (C 262 Hz) and Korean hyang-ak (C 311 Hz) pitches, eight lanes of preset
instruments, a pattern grid
cut down to notes and a handful of effects — and sketches kept on the phone or
online, where Microtone opens them as ordinary projects.

**Status: prototype.** It runs and sends; it is not deployed anywhere yet.

## Running it

```sh
npm run serve        # python3 -m http.server 8738, then http://localhost:8738/
node --test          # the pure half against the real engine and parser
```

`core` here is a symlink to the repository's shared `../core`. A plain static
server has no online-projects API, so Files shows only the phone's own
sketches and Save as… offers the `.taud` file besides. To try the online side,
serve a staged copy (`node tools/stage-site.js microtone-touch-worker
build/microtone-touch-worker`, from the repository root) under `wrangler dev`
with the microtone Worker's code and bindings, on `localhost` with
`ONLINE_DEV_LOGIN=1` and no SceneID pair in its `.dev.vars`.

Its version is this directory's `package.json`, independent of the tracker's.

## What is where

| File | Contents |
|---|---|
| `src/app.js` | The page: state, editing, transport, recording, sheets, where the sketch in hand is kept |
| `src/topbar.js` | The transport bar's wordmark, fitted to the room left, and the hamburger menu |
| `src/about.js` | About, opened by tapping the wordmark (or from the menu when the bar has no room for it); its version is read from `package.json`, which ships for that |
| `src/theme.js` | Dark, dim and light (the tracker's three), or the phone's own; `index.html` applies the saved one before the first paint |
| `src/sketch.js` | The sketch model, and its road to and from a `.mtsk` file |
| `../core/sketch/pack.js` | The instrument pack, synthesised (no samples are shipped) — in `core/` because Microtone builds it too, to open a sketch |
| `../core/sketch/mtsk.js` | The `.mtsk` file, and the Taud song a sketch plays as |
| `src/lattice.js` | Isomorphic layouts, derived from each tuning's own fifth, each turned so the head key's octaves stand in a vertical column |
| `src/keyboard.js` | The canvas keyboard and drum pads, multi-touch |
| `src/grid.js` | The pattern grid |
| `src/notes.js` | Note names as plain text |
| `src/saving.js` | Save, Save as…, the sign-in and the conflicts they may need, the `.taud` to take away |
| `src/library.js` | Sketches kept on this phone (IndexedDB) |
| `src/files.js` | The Files panel and the Load… sheet: both places' sketches, opened, renamed, copied, deleted |
| `src/split.js` | The splitter, the stacked / side-by-side knob and the hand knob |

## How a sketch maps onto Taud

A sketch has eight lanes, each holding one preset, and up to sixteen sections;
a section is one cue with one 64-row pattern per lane (pattern number =
section × 8 + lane, so an edit re-uploads exactly one). Cells hold a note or a
key-off and at most one effect — Slide (`G`), Vibrato (`H`), Roll (`Q`) or
Fade (`D`) — which lasts until the lane's next note and is written out on
every row of that run. There are no volume or pan columns. The song loops with
`JMP 0` on its last cue (or halts, if looping is off).

## Where sketches are kept

The bar holds the transport alone — the wordmark (as much of "Microtone™ Touch"
as fits), Play, Record, Section / Song — and the hamburger holds the rest, one
level deep: BPM… (with whether the song loops), Temperament…, Save, Save as…,
Load…, Files… and Theme…. The sketch on screen is a working copy, kept in local storage
after every edit; Save writes it back where it was last saved or opened (its
*home*), Save as… picks a name and a place, and opening another sketch or
starting a new one asks first if there are unsaved changes, then starts a new
undo history.

ON THIS PHONE is IndexedDB, holding the sketch model itself, so nothing is
lost. ONLINE is Microtone's online projects, where a sketch is a `.mtsk`; it
opens under its file name, and a save quotes the etag it was opened with, so
one saved from elsewhere since is never silently replaced. Files takes the
whole screen with the two lists: a screen segment each on a foldable, two
columns where there is room, a tab each on a phone held upright.

A sketch goes ONLINE as a `.mtsk` (`microtone-worker/assets/MICROTONE_SKETCH_FORMAT.md`):
the header, the 128 pattern images of sections A…P as one compressed blob, and
the name — a few hundred bytes, where a `.taud` of the same sketch is ~73 KB,
nearly all of it the instrument pack. The pack does not travel: Touch and
Microtone both build it (`core/sketch/pack.js`), pinned byte for byte to
`microtone-worker/assets/MicrotoneTouch.tsii`, and the server keeps sketches in
64 slots of their own beside the 8 project slots. Microtone lists them under
File → Online projects and opens one as a new project. The file Save as… hands
over to download or share is still a `.taud`, self-contained, so it opens
anywhere.

Everywhere else a splitter sits between the song and the keyboard: drag it to
resize, double-tap it to reset, and tap its knob to switch between stacked and
side by side. Side by side, a second knob puts the keyboard on the left for a
left-handed player (one setting, whichever way the phone is held); stacked,
the keyboard is always the bottom panel. The choice is remembered per screen orientation (upright starts
stacked, sideways side by side), and each of the four combinations keeps its own
split. On foldables the song and the keyboard take one screen segment each
(`horizontal-viewport-segments` / `vertical-viewport-segments`) and the splitter
steps aside; a half-folded posture without segments starts with the keyboard
taking the larger share.
