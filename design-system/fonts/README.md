# Motif — Microtone's typefaces

Motif is [Chivo Mono](https://github.com/Omnibus-Type/Chivo) rebuilt for four
jobs in the tracker, plus the symbols a tracker grid needs and twelve Chinese
pitch names. It is built here and shipped from `core/fonts/`, where the tracker
and Microtone Touch both serve it.

| Family | File | Used by | What changes |
|---|---|---|---|
| **Motif Grid** | `motif-grid.woff2` | Timeline, Cues, Patterns, chord and notation makers, keymap (`--cv-font`), every note shown as a symbol outside them, vibrato wave buttons; Microtone Touch's notes (grid, keys) | every glyph 20% wider in the same 600-unit cell; ASCII, `·`, `−`, the symbols below and the lü only |
| **Motif Transport** | `motif-transport.woff2` | the transport readouts (Oct, Inst, Step, Cue, Row, BPM, Spd) | every glyph and its cell 10% narrower; ASCII only |
| **Motif Code** | `motif-code.woff2`, `motif-code-italic.woff2` | the Motif editor, the manual's code | restricted proportional: `i I l` ×0.75, `M m W w` ×1.25 (stems as heavy as `n`'s and `H`'s at every weight), digits and punctuation stay on the cell; all of Chivo Mono's characters |
| **Motif Mono** | `motif-mono.woff2` | every other monospace in the tracker (`--mono-font`): hex and number fields, indexes, readouts, key names, canvas labels; also what Grid and Transport fall back to | Motif Code with every letter left on the cell — Chivo Mono's own widths, strictly monospaced; all of Chivo Mono's characters |

In all of them the capital **O is square and wide** and the **zero narrow and
oval**, the way HP's terminals told them apart — no slashed or dotted zero.
**C, G and c are opened**: their terminals end further round the bowl than
Chivo's, so C and G stand apart from O, 0 and 6, and c from e and o, at grid
sizes and at heavy weights. Every face is variable on weight, 100–900, with
Chivo's own three masters (Thin, Medium, Black); the drawn symbols and the lü
follow the weight too.

Why separate families rather than a width axis: some browsers lack
`font-variation-settings`, and unlike body text the grid cannot tolerate a
width that silently fails to apply.

## Building

```sh
python3 build.py              # every variant, then proof sheets in build/proof/
python3 build.py --no-proof
```

Needs Python 3.11+ and fontTools with brotli (WOFF2); the proofs need `hb-view`
(HarfBuzz) and Pillow. The build is deterministic: the same sources and
`motif.toml` make the same bytes (the date in `motif.toml` is stamped into the
fonts). It writes the `.woff2` files and `OFL.txt` into
`core/fonts/`, which are committed — the sites have no build step —
and installable `.ttf` copies into `build/` (not committed).

**To try other widths**, change the two numbers at the top of `motif.toml` —
`[grid] widen` and `[transport] narrow` — rebuild, and reload the app. Every
other dial (the O's squareness, the apertures of C G c, the code face's
letters and factors, the symbols' stroke weight, the lü's weights and size) is
in the same file with a comment. `test/node/motif-font.test.js` (run from
`microtone-worker/`) reads the shipped fonts and fails if they no longer match
`motif.toml`, or lack a character the cell painter writes — so a config edit
that was never rebuilt shows up there.

## How it is made

Everything is fontTools working on Chivo Mono's own variable TTF — no
glyphsLib/fontmake, so `sources/` holds the compiled release rather than the
`.glyphs` file (its outlines are the same).

- **Wider and narrower without getting bolder or lighter** (`widths.py`). A
  plain stretch thickens every vertical stem by the stretch. Instead each
  master takes its *x* coordinates from the weight whose stems, once scaled,
  come out exactly as thick as the master's own, and its *y* coordinates from
  the master itself. Chivo's masters are point-compatible, so mixing two
  weights' coordinates is legitimate. `[stems] compensate` dials this between
  none and full. In the grid face a widened glyph also stops `margin` units
  short of the cell edge (`#`, `M`, `W`, `@` widen less or not at all), so
  neighbouring cells never touch.
- **The code face's narrow and wide letters** (`widths.py matched_weights`)
  get their stems from wherever they match the `n`'s (lowercase) or the `H`'s
  (capitals) at that master, not from their own. Chivo squeezes `M m W w`
  harder the heavier it gets — at Black an `m`'s stems are three quarters of
  an `n`'s — because they must share one cell; widened, they have the room
  again. A narrowed `i I l` at Black needs a weight heavier than Black, which
  is read past the master (`[code] extrapolate`; these letters have no counters
  to close). Strokes are measured across the letter's leftmost stroke, at a
  height where that stroke thickens steadily with weight (low down, `W`'s
  diagonals merge). A lone mark above a narrowed letter — the `i`'s dot, a
  single accent — keeps its own size and only moves with the letter.
- **The O** (`widths.py hp_capital_o`) is redrawn as a superellipse in each
  master's own box, pushed out by `[capital_O] widen`, keeping the master's
  stroke thicknesses; italic O is drawn upright and slanted after.
- **The apertures** (`apertures.py`): Chivo cuts the arms of C, G and c level,
  about where the bowl turns vertical. Each cut moves `[apertures]` units
  further from the middle and stays level; the outer and inner curves into it,
  from the bowl's top or bottom, are refitted as the same curves made shorter,
  every spline keeping its points (least squares on the TrueType off-curve
  points, within 1 unit of Chivo's curve), so the masters still interpolate.
  The cuts are found in the outline, not named, and the accented forms follow
  their letter; ¢ and © are drawn separately in Chivo and keep its closed c.
- **The symbols** (`symbols.py`, `stroke.py`) are centre lines stroked with an
  *elliptical* nib whose axes are Chivo's vertical stem and horizontal bar at
  that weight (times `[symbols] weight`), so a symbol's verticals, horizontals
  and diagonals carry the same contrast as the letters' — and apexes are cut
  flat the way Chivo cuts `^ < > v`. The point count of a stroke depends only
  on its centre line, never on the nib, so the three masters interpolate.
  A flat's bowl leaves the stem a little above mid-height, is widest high up
  and runs in one long curve into the foot, which it shares with the stem in
  a single flat cut; double and triple flats are full-size flats, each bowl
  leaning on the next stem, as engraved music writes them.
- **The lü** (`cjk.py`) come from Chiron Hei HK, a CFF2 variable font: each is
  read at the Chiron weights `[cjk] weights` maps onto Motif's masters,
  converted to quadratics with cu2qu across all three at once (so they stay
  compatible), and centred in two cells. `sources/ChironHeiHK-lu.otf` is those
  twelve glyphs cut out of the 26 MB original; `build.py --chiron PATH`
  refreshes it from a full `ChironHeiHKVF.otf`.

## Character set

`core/fonts/motifglyphs.js` names every code point below; the painter
(`src/ui/cellpaint.js`) is the grid's only writer of them.

| Code points | Cells | What |
|---|---|---|
| U+266F ♯, U+266E ♮, U+266D ♭, U+1D12A 𝄪, U+1D12B 𝄫, U+1D260 (triple flat) | 1 | Unicode accidentals |
| U+1D1EB–U+1D1EE | 1 | Stein-Zimmermann quarter-tone accidentals (Unicode 18.0): half sharp, one-and-a-half sharp, reversed flat, reversed flat and flat |
| U+F000 / U+F001 | 1 | Kite up tick (top on the capitals) / down tick (bottom on the baseline) |
| U+F002 / U+F003 | 1 | Kite double up / double down, spanning the capitals |
| U+F004 | 1 | Kite's unmarked degree, the big dot |
| U+F00C / U+F00D | 1 | volume slide up / down (the tick, centred) |
| U+F00E / U+F00F | 1 | panning slide left / right |
| U+F010–U+F018 | 2 | two-cell sharp, flat, double sharp, double flat, triple flat, half sharp, sesquisharp, reversed flat, sesquiflat — matched by eye to one width, `DW_WIDTH` in `symbols.py` (a sharp's beams span it; a flat's open bowl gets about four fifths) |
| U+F01B | 2 | the grid's natural: the minus centred on two cells, so a note is one string (`C` + U+F01B + `4`) |
| U+F019 / U+F01A | 2 | two-cell triple sharp (♯𝄪) and quadruple sharp (𝄪𝄪, the two enlarged and overlapping), which Unicode has no code point for |
| U+F030–U+F033 | 4 | note sentinels: key-off, note cut (three wedges), fade (three waves), fast fade (sinc with a wedge) |
| U+F040–U+F044 | 2 | vibrato waveforms: sine, ramp down, square, random, ramp up — one period edge to edge, so `` draws two that join |
| 黃大太夾姑仲蕤林夷南無應 | 2 | the twelve lü (Grid and Code) |

The grid's natural (the `-` of `C-4`) is U+F01B, the minus sign centred on
the two-cell accidental slot. In Motif Grid, `·`, `-`, `−` and `+` are moved to
the middle of the capitals (`[grid] centred`), level with the Kite marks and
the digits, so empty cells, naturals and fine slides line up with the notes.

## Licence

The fonts are under the [SIL Open Font License 1.1](OFL.txt), as their sources
are: Chivo Mono © 2018 The Chivo Project Authors (*Chivo is a trademark of
Omnibus-Type*, which is why this is called Motif); Chiron Hei HK © 2023–2026
Tamcy, based on Source Han Sans © 2014–2025 Adobe. Neither source declares a
Reserved Font Name. The build scripts are part of Microtone.

Sources, as copied in on 2026-10-20:

| File | From | SHA-256 |
|---|---|---|
| `sources/ChivoMono-VF.ttf` | `ChivoMono[wght].ttf`, Chivo Mono 1.008 | `725256f30b7b1b25dd001a96ff8d4a23773197bb886cd847a97ff8eabc9c1d9d` |
| `sources/ChivoMono-Italic-VF.ttf` | `ChivoMono-Italic[wght].ttf`, 1.008 | `e6c3e5469d99fee864414845d95ef6aa2fb166121bddd7486d6958c4a54e3aea` |
| `sources/ChironHeiHK-lu.otf` | cut from `ChironHeiHKVF.otf` 2.609 | (original: `6ae76cc51e033a8ba83d13b8261186706b6019a99ecdd8519500b5dda56ab53e`) |
