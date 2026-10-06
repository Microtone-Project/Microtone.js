# Microtone Touch

A phone sketchpad for the notes a piano cannot play: an isomorphic keyboard in
4- to 53-tone equal temperaments, Bohlen–Pierce, or Shi'er lü at the Chinese
a-ak (C 262 Hz) and Korean hyang-ak (C 311 Hz) pitches, eight lanes of preset
instruments, a pattern grid
cut down to notes and a handful of effects — and sketches kept on the phone or
online, where Microtone opens them as ordinary projects.

Served at **https://touch.microtone.cc**, in English and Korean.

## Running it

```sh
npm run serve        # python3 -m http.server 8738, then http://localhost:8738/
node --test          # the pure half against the real engine and parser
```

`core` here is a symlink to the repository's shared `../core`. A plain static
server has no online-projects API, so Files shows only the phone's own
sketches and Save as… offers the `.taud` file besides. To try the online side,
run this directory's own Worker, from here:

```sh
npx wrangler d1 migrations apply microtone-online --local
npx wrangler dev --port 8789      # .dev.vars here: ONLINE_DEV_LOGIN=1
```

Its version is this directory's `package.json`, independent of the tracker's.

## Deploying

`wrangler.toml` here is the Worker `microtone-touch`: the tracker's own server
code (`../microtone-worker/server/worker.js`) with the tracker's D1 database
and R2 bucket, so a sketch saved on either site is the same sketch — only the
static files differ. Its `[build]` stages this directory with `core/` laid in
(`tools/stage-site.js` → `build/microtone-touch-worker`), which is what is
uploaded; `.assetsignore` keeps the tests, this README, `wrangler.toml` and
`.dev.vars` out of it. A test holds the database id and the bucket to the
tracker's `/wrangler.toml`.

Setting it up once, in the Cloudflare dashboard:

1. **Workers & Pages → Create → Import a repository**: this repository, the
   Worker named `microtone-touch`, **root directory** `microtone-touch-worker`,
   no build command (the config's `[build]` stages the site), deploy command
   `npx wrangler@4.120.0 deploy --compatibility-date 2026-07-10` (never with
   `--assets`, which would ship the site without `core/`), version command
   `npx wrangler versions upload`.
2. **Settings → Domains & Routes → Add → Custom domain**: `touch.microtone.cc`.
3. **Settings → Variables and Secrets**: `SCENEID_CLIENT_ID` and
   `SCENEID_CLIENT_SECRET`, the same pair as the `microtone` Worker's (or
   `npx wrangler secret put …` from here). Sign-in switches itself on once both
   are there; SceneID already lists
   `https://touch.microtone.cc/api/online/auth/callback`.

The database schema is the tracker's, applied once for both
(`npx wrangler d1 migrations apply microtone-online --remote`, from here or
from the repository root). Every push to the branch then deploys both sites.

## Languages

Every word on screen comes from `src/i18n.js` and the tables in `src/lang/`
(`en.js` is the reference list; `ko.js` the Korean). Touch starts in the
phone's own language when it speaks it, and English otherwise; Language… in
the menu overrides that, and switches at once. To add a language, copy `en.js`
to `<code>.js`, translate the values, and register the code in `i18n.js` and
in `index.html`'s two early scripts — `test/node/i18n.test.js` says what is
missing.

## What is where

| File | Contents |
|---|---|
| `src/app.js` | The page: state, editing, transport, recording, sheets, where the sketch in hand is kept |
| `src/topbar.js` | The transport bar's wordmark, fitted to the room left, and the hamburger menu |
| `src/about.js` | About, opened by tapping the wordmark (or from the menu when the bar has no room for it); its version is read from `package.json`, which ships for that |
| `src/theme.js` | Dark, dim and light (the tracker's three), or the phone's own; `index.html` applies the saved one before the first paint |
| `src/i18n.js`, `src/lang/` | The languages: the phone's own or the one chosen, `t()` and its kin, and the English and Korean tables; `index.html` sets the page's language before the first paint |
| `wrangler.toml` | The `microtone-touch` Worker: the tracker's server and storage, Touch's files |
| `src/sketch.js` | The sketch model, and its road to and from a `.mtsk` file |
| `../core/sketch/pack.js` | The instrument pack, synthesised (no samples are shipped) — in `core/` because Microtone builds it too, to open a sketch |
| `../core/sketch/mtsk.js` | The `.mtsk` file, and the Taud song a sketch plays as |
| `src/lattice.js` | Isomorphic layouts, derived from each tuning's own fifth, each turned so the head key's octaves stand in a vertical column (or lie in a row); the fat-finger touch zones |
| `src/keyboard.js` | The canvas keyboard and drum pads, multi-touch; one fat-finger touch is told to the app as one finger per key |
| `src/grid.js` | The pattern grid |
| `src/notes.js` | Note names as plain text |
| `src/saving.js` | Save, Save as…, the sign-in and the conflicts they may need, the `.taud` to take away |
| `src/library.js` | Sketches kept on this phone (IndexedDB) |
| `src/files.js` | The Files panel and the Load… sheet: both places' sketches, opened, renamed, copied, deleted |
| `src/split.js` | The splitter, the stacked / side-by-side knob and the hand knob |

## The harmonic table's own options

Two buttons beside the layout picker show only while the board is the harmonic
table (major thirds one way, fifths the other, minor thirds up-left), and are
remembered with the other keyboard settings:

- **↕ / ↔** stands the octaves up the board (the default) or lays them across
  it: the row of major thirds turns level, so in 12-TET the bottom row reads
  C E G♯ C′ E′ …, and in every other tuning the board is turned until its own
  octave step lies to the right.
- **Fat fingers** gives every corner where three keys meet, and every edge where
  two do, a touch point of its own: one finger there plays all of them — on
  this table a major or minor triad at a corner, a third or a fifth at an
  edge. The points are drawn as dots in the gaps. A finger keeps the zone it
  is in until it is clearly out of it, and sliding to another zone keeps the
  keys the two share sounding. Each key held counts as a finger, so a held
  triad spreads across lanes holding the same preset, as a three-finger chord
  does.

On a phone held upright the two buttons take the lane tag's place in the bar.

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
Load…, Files…, Theme…, Language… and a link to the tracker. The sketch on screen is a working copy, kept in local storage
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
