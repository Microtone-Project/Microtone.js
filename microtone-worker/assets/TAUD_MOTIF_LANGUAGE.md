# Taud Motif Language

**Motif** is Microtone's way of writing a song as a program. A Motif program — written in the **Taud Motif Language**, TML for short, and kept in a `.tml` file — describes the music itself (notes, melodies, chords, instruments, the arrangement) and the rules that make it (loops, functions, probability, transformations). Building the program makes a whole Taud project: the patterns and cues, an instrument bank drawn from a soundfont, the mix, the mastering chain and the texts. The project carries its program, so it can be opened in the Motif view, changed and built again.

TML is a small language of its own rather than JavaScript, so that a program can be shared and built by anyone without being trusted: it can reach nothing but the builtins listed here — not the page, the network, the files or the clock — and it runs on a budget of steps, so the worst a program can do is fail to build.

Companion documents: the **Taud File Format** defines the project a build writes, and the **Note Effects** reference what the effect letters in a program mean.

- **Created** by CuriousTorvald, 2026-10-11. Language version 1.
- **Files** — UTF-8 text with the extension `.tml`, at most 2 MiB.
- **Determinism** — the same program, built against the same soundfont by the same version of Microtone, makes the same project byte for byte, in the app and on the command line alike. Nothing in a program depends on the time, the machine or chance that is not seeded.

## Conformance language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold.

## 1. A first program

```
tml 1
song {
  title: "Three bars"
  tuning: "31-TET"
  tempo: 110
  bars: 3
  bar_rows: 16
}

instrument PIANO { bank: 0, program: 0 }
instrument KIT   { bank: 128, program: 0 }

lane tune { inst: PIANO }
lane kick { inst: KIT, pan: $80 }

// A tune in 31-TET: Dp is D half-flat, the neutral third over B flat.
melody(tune, at(1), "Bb4:4 Dp5:4 F5:8 | ~Ft5:12v r:4 | Bb5:16")

for bar in 1..3 {
  hit(kick, at(bar), midi(36), 50)
  if chance(0.5) { hit(kick, at(bar, 10), midi(36), 36) }
}
```

Line by line: every program starts with `tml` and the language version. The `song` block says what the song is — its tuning, tempo and length. Each `instrument` is a preset of the soundfont, and each `lane` is one of the song's monophonic parts, playing an instrument. Then come the events: `melody` writes a line from a string of notes (§8.4), and a `for` loop puts a kick drum on the first row of every bar — and, on a coin toss, a second one; the coin is seeded (§10), so the same program always tosses it the same way.

## 2. How a program runs

A program runs once, from the top to the bottom. Its declarations (`song`, `instrument`, `lane`, `section`, `master`) describe the song; its other statements compute — with numbers, lists, records and functions — and place events on the lanes. Nothing is played while it runs: what it leaves behind, the **score**, is then built into a project (§11).

The song is declared first, before anything that needs its tuning or its length; the instruments are declared before the first lane. Everything else may come in any order, and the events a program places merge into the lanes' cells by the rules in §8.2.

The interpreter **MUST** give a program nothing but the values and builtins this document defines, and **MUST** stop a program that exceeds the limits in §12 with an error rather than run it further.

## 3. Lexical structure

### Comments and line breaks

`//` starts a comment that runs to the end of the line; `/*` … `*/` encloses one that may span lines (they do not nest).

A line break ends a statement, as `;` does. Inside `( )`, `[ ]` and a record's `{ }`, line breaks are ignored, and so they are after an operator, a comma, `=`, `=>`, `then` and `else`: break a long expression after an operator or inside brackets.

```
let total = 1 + 2 +
  3                        // continues: the line ended on an operator
let chord = [
  'C4', 'E4', 'G4',        // continues: inside brackets
]
```

### Numbers

| Form | Example | Value |
|---|---|---|
| decimal | `120`, `0.8`, `1e-3` | as written |
| tracker hexadecimal | `$7300`, `$80` | hexadecimal, as the pattern grid writes it |
| hexadecimal | `0x7300` | the same |
| binary | `0b1010` | ten |

A number may not run straight into letters: `12ab` is an error. Every number is an IEEE 754 double; the bitwise operators work on whole numbers as 32-bit integers.

### Strings

`"…"` is a string on one line. Escapes: `\n` `\t` `\r` `\0` `\\` `\"` `\'` `\$` `\{` `\}`, `é` (four hexadecimal digits) and `\u{1F3B5}` (one to six).

`${…}` inside a string puts the value of an expression there: `"${n} bars"`. A list or a record reads as TML would write it.

`"""…"""` is a string over several lines. When the opening quotes end their line, that line break is not part of the text; when the closing quotes start a line of their own, the line break before them is not either, and their indentation is taken off every line — so the text can be indented with the code around it:

```
fn about() {
  return """
    First paragraph.

    Second paragraph.
    """
}
```

reads `"First paragraph.\n\nSecond paragraph."`.

### Pitches

`'…'` is a pitch: a note name in the song's tuning, such as `'C4'` or `'Cp4'` (§7.2). It is a number — a count of steps — and needs the song to be declared first.

### Names and reserved words

A name is ASCII letters, digits and `_`, not starting with a digit; case matters. These words are reserved and cannot be names:

`tml` `let` `fn` `for` `in` `while` `if` `then` `else` `return` `break` `continue` `and` `or` `not` `true` `false` `none`

`song`, `instrument`, `lane`, `master` and `section` are declarations only at the start of a statement, and `by` only after a range, so all six may still be used as names (`fn dr(lane, bar)` is fine).

## 4. Values

| Type | Written | Notes |
|---|---|---|
| number | `42`, `0.5`, `$7300`, `'D5'` | an IEEE 754 double |
| string | `"text"` | |
| bool | `true`, `false` | |
| none | `none` | the absence of a value |
| list | `[1, 2, 3]` | ordered, changeable; a trailing comma is allowed |
| record | `{ root: 2, ivs: [0, 10] }` | named fields in the order first written, changeable |
| range | `1..8`, `0..<14 by 2` | whole numbers, made on demand (§5) |
| function | `fn(x) => x * 2` | §6 |
| lane | declared by `lane` | fields `name`, `label`, `index`, `inst` |
| instrument | declared by `instrument` | fields `name`, `slot` |

A record's fields are separated by commas or line breaks, and `{ name }` is short for `{ name: name }`. A field name may also be a string: `{ "pad 1": 3 }`.

Lists and records are shared, not copied, when assigned or passed: changing one changes it for every name that refers to it (use `copy` for a separate one).

**Truth.** `false`, `none`, `0` and `""` are false; every other value is true.

**Equality.** `==` compares numbers, strings and bools by value, lists, records and ranges by their contents, and functions, lanes and instruments by identity.

## 5. Expressions

From the loosest binding to the tightest:

| Operators | Meaning |
|---|---|
| `if c then a else b` | `a` when `c` is true, else `b` |
| `or` | the left value when it is true, else the right |
| `and` | the left value when it is false, else the right |
| `not` | true when the value is false |
| `==` `!=` `<` `<=` `>` `>=` | comparisons (numbers with numbers, strings with strings); they do not chain |
| `a..b` `a..<b` `… by s` | a range: `..` includes `b`, `..<` stops before it |
| `\|` | bitwise or |
| `^` | bitwise exclusive or |
| `&` | bitwise and |
| `<<` `>>` | bit shifts |
| `+` `-` | add (numbers, strings, lists) and subtract |
| `*` `/` `%` | multiply (a list or string times a whole number repeats it), divide, modulo |
| `-` `+` `~` (prefix) | negate, plus, bitwise not |
| `**` | power, right to left: `2 ** 3 ** 2` is 512, `-2 ** 2` is −4 |
| `f(…)` `x[i]` `x.name` | call, index, field |

The bitwise operators bind tighter than the comparisons, so `variant & 1 == 0` means `(variant & 1) == 0`.

`%` is a **floored** modulo: the result takes the sign of the divisor, so `-1 % 31` is 30 and a pitch class is never negative. Division and modulo by zero are errors.

**Ranges** run between whole numbers. `1..8` is one to eight; `0..<14 by 2` is 0, 2, … 12; `5..1` is empty, and `5..1 by -1` counts down. A range is a value: loop over it, index it, or make a list of it with `list`.

**Indexing.** `xs[i]` counts from 0; a negative index counts from the end (`xs[-1]` is the last item). `xs[a..b]` and `xs[a..<b]` are slices, of lists and strings alike. `r["name"]` is the field `name`, as `r.name` is. Reading a field a record does not have is an error; `get(r, "name", default)` is the gentle way.

**Calls** take positional arguments, then named ones: `melody(lead, at(9), THEME, vol: 55)`. A named argument names a parameter.

**Function values** are written `fn(x, y) => expression` or `fn(x, y) { statements }`.

## 6. Statements

| Statement | |
|---|---|
| `let name = value` | a new name in this block; `let [a, b] = pair` unpacks a list |
| `name = value`, `xs[i] = value`, `r.f = value` | change an existing name, item or field; also `+=` `-=` `*=` `/=` |
| `if c { … } else if d { … } else { … }` | `else` may start the line after the closing brace |
| `for x in xs { … }` | each item of a list or range, each character of a string |
| `for i, x in xs { … }` | with its index (a record gives each field's name and value) |
| `for [a, b] in pairs { … }` | unpacking each item |
| `while c { … }` | |
| `break`, `continue` | leave the loop, or go on to its next round |
| `fn name(a, b = 2) { … }` | a function; `return value` (or `return` for none) |
| `{ … }` | a block: a scope of its own for the names it lets |
| an expression | a call, usually, for what it does |

A `for` loop over a list walks a copy of it, so changing the list inside the loop does not change the walk.

**Functions.** A parameter may have a default, written after the ones without, which may use the parameters before it: `fn f(a, b = a * 2)`. A function sees the names around the place it was written and keeps them (a closure). A named function can be used anywhere in the block it is written in, even above it — a program can start with the song and leave its helper functions for later.

**Blocks after conditions.** The `{` after the condition of `if` and `while` and after the list of `for` starts the block, so a record written there needs parentheses: `for k, v in ({ a: 1 }) { … }`.

## 7. Declarations

### 7.1 `song`

```
song { title: "…", tuning: "31-TET", tempo: 120, speed: 6, bars: 64, bar_rows: 14 }
```

| Option | Default | |
|---|---|---|
| `bars` | — | **Required.** How many bars the song lasts |
| `bar_rows` | 16 | Rows in a bar, 1–64 |
| `cue_bars` | as many as fit in 64 rows | Bars in a cue; a cue holds at most 64 rows |
| `beat_rows` | 4 | Rows between the grid's beat bands (the bar bands are `bar_rows`); display only |
| `tempo` | 125 | Beats per minute, 25–1048 |
| `speed` | 6 | Ticks per row, 1–127 |
| `tuning` | `"12-TET"` | The notation pitches are counted and named in (§7.2) |
| `a4` | 440 | The frequency A4 sounds at, in Hz |
| `title`, `composer`, `copyright` | empty | The project's name, author and copyright |
| `message` | empty | The Project message |
| `signature` | `"Microtone.js"` | The file's signature, up to 14 ASCII characters |
| `surround` | `"stereo"` | `"stereo"`, `"planar"` (the circle) or `"spatial"` (the sphere) |
| `format` | 2; 3 for a surround song | 3 is the wide cell (TAUD_FILE_FORMAT.md §5.5), for surround songs only |
| `global_volume`, `mixing_volume` | 128, 128 | The song's two volumes, 0–255 |
| `seed` | 1 | The random stream's seed (§10) |
| `soundfont` | the bundled GeneralUser GS | The soundfont the instruments come from: a file name, which the app asks for when it is first needed and the command line finds next to the `.tml` |
| `retune` | `false` | Measure every zone the song plays and correct its tuning onto the grid (§11) |

An option the song does not have is an error, with a suggestion when it looks like a misspelling.

### 7.2 Tunings and pitches

A pitch is a whole number of **steps** of the song's notation, counted from degree 0 of period 0. In 31-TET, C0 is 0, C4 is 124, and adding 31 goes up an octave; in 12-TET a step is a semitone and C4 is 48.

A note name is the name the Timeline gives the degree, followed by its period number (the octave, in an octave-based tuning): `'Cp4'` is the degree named `Cp` in period 4 — in 31-TET, just below C5. Degree names are a letter A–J; after it an accidental (`#` sharp, `b` flat, `t` half sharp, `p` half flat, `x` double sharp, `B` double flat, `3` and `4` triple and quadruple sharp, `T` triple flat), and before it, in the Kite notations, a tick (`u` up, `d` down, `U` and `D` double). The plain dot of the Kite notations is silent: the unmarked degree is spelt with the letter alone.

`tuning` takes:

- a built-in notation, by the name the Project view gives it — `"12-TET"`, `"24-TET"`, `"31-TET"`, `"41-TET (Kite)"`, `"53-TET (Pythagorean)"`, `"Shi'er lü"`, `"Equal-Tempered Bohlen-Pierce"` and the rest — or by its notation number, such as `310`;
- `"N-TET"` or `"N-EDO"` for any equal division of the octave: the built-in notation when there is one, otherwise a custom notation saved with the project, its degrees named after the nearest quarter tone;
- a record for a scale of your own: `{ name: "Pelog", cents: [0, 120, 270, 540, 670, 785, 950], period: 1200, names: ["C", "D", "E", "F", "G", "A", "B"] }` (`period` defaults to 1200 cents; `names` to the nearest quarter tones), or `{ name: "29-TET", edo: 29 }`.

Notations that list a fixed set of notes rather than repeating a period, such as ProTracker pitch, cannot be used.

### 7.3 `instrument`

```
instrument EP { bank: 0, program: 4, layer_gain: 3 }
```

An instrument is a preset of the song's soundfont, and declaring one binds its name. Instruments take the slots 1, 2, 3, … in the order they are declared (at most 255), and all of them come before the first lane.

| Option | Default | |
|---|---|---|
| `bank`, `program` | — | **Required.** The preset: bank 0–128 (128 holds the drum kits), program 0–127 |
| `name` | the soundfont's | The instrument's name in the project |
| `retune` | `true` | Whether the song's `retune` measures this instrument (leave drums out) |
| `layer_gain` | — | Decibels applied to every layer of a layered instrument, as the layer-mix octet that comes nearest (TAUD_FILE_FORMAT.md §7.5) |
| `min_fadeout` | — | Every zone fades out at least this fast (in the engine's fadeout units, which a soundfont's release becomes at the song's tempo) |
| `fadeout` | — | Every layer and zone fades out at exactly this rate |
| `nna` | — | The New Note Action: `"off"`, `"cut"`, `"continue"` or `"fade"` |
| `layers` | all | Which layers of a layered preset to keep, numbered from 0; the others are removed |

### 7.4 `lane`

```
lane bass { inst: FRETLESS, pan: $80, label: "Fretless", trim: 0.8 }
```

A lane is one of the song's monophonic parts; declaring one binds its name. Lanes are numbered in the order they are declared, at most 64 (more than 32 makes a 64-lane project).

| Option | Default | |
|---|---|---|
| `inst` | — | **Required.** The instrument the lane plays |
| `pan` | — | The lane's starting pan, written as `S $8xxx` on the song's first row: 0 left, 128 ($80) centre, 256 ($100) right, and round the circle past that in a surround song |
| `label` | the lane's name | What the lane's patterns are named after |
| `trim` | 1 | Every volume the lane sets is multiplied by this (`db(-3)` is a trim of −3 dB) |
| `jitter` | 0 | Every volume the lane sets moves by up to this much either way, by a fixed noise (§11) |

### 7.5 `section`

```
section "theme" 9..16
```

Names part of the arrangement: every cue that starts in those bars names its patterns `"<lane label> <section>"`, so the Timeline reads "Lead theme", "Bass theme 2". Bars may be given as `9..16` or `9..<17`. A cue in no section names its patterns after the lane alone.

### 7.6 `master`

```
master { trim_db: -2, lim_on: true, lim_ceiling_db: -0.2 }
```

The song's mastering chain (the Mastering view's), saved with the project. An option left out keeps the Mastering view's default; `on` defaults to `true` once there is a `master` block at all.

| Option | |
|---|---|
| `on` | The chain is switched on |
| `trim_db` | Input trim, dB |
| `hp_on`, `hp_freq`, `hp_slope` | High-pass: on, cut-off in Hz, 12 or 24 dB per octave |
| `eq_on`, `eq` | Equaliser: on, and up to four bands `{ on, type, freq, gain_db, q }`, `type` being `"low_shelf"`, `"peak"` or `"high_shelf"` (only the first and last band may shelve) |
| `comp_on`, `comp_detector`, `comp_thresh_db`, `comp_ratio`, `comp_attack_ms`, `comp_release_ms`, `comp_knee_db`, `comp_makeup_db` | Compressor; the detector is `"peak"` or `"rms"` |
| `width_on`, `width` | Stereo width (1 is unchanged) |
| `lim_on`, `lim_true_peak`, `lim_ceiling_db`, `lim_release_ms` | Limiter |
| `out_gain_db` | Output gain, dB |

## 8. Placing notes

### 8.1 Rows

Events are placed by **row**, counted from 0 at the start of the song. `at(bar, row)` is the row of a bar (counted from 1) and a row within it (from 0): with 14-row bars, `at(9)` is row 112 and `at(9, 4)` row 116. A row outside the song is an error.

### 8.2 Cells, and how writes merge

Each lane holds one cell per row: a note, an instrument, a volume-column command, a panning-column command and one effect (two in a format-3 song). Every write to a row MERGES into its cell. Two writes that give one field two different values are a mistake in the program and stop the build, naming the lane, the bar and the row — with two exceptions:

- a note replaces a key-off, note cut or note fade written to that row before it;
- `keyoff`, `cut` and `fade` write nothing on a row that already holds a note.

So a phrase can end with a key-off where the next phrase begins with a note, in either order.

### 8.3 The event builtins

Volumes are 0–63 in a format-2 song and 0–255 in a format-3 one. An effect is its letter — `"G"`, `"S"` — or its symbol, and its argument a number written as on the grid: `fx(lane, row, "S", $7300)` is `S $7300`.

| Builtin | Writes |
|---|---|
| `hit(lane, row, pitch, vol, fx, arg, inst, pos, delay)` | A note with the lane's instrument (or `inst`), optionally its volume, an effect, a position (`pos: dir(az, el)`, format 3) and a delay of 1–15 ticks (`S $Dx`) |
| `keyoff(lane, row)`, `cut(lane, row)`, `fade(lane, row)` | Key-off, note cut, note fade |
| `fx(lane, row, op, arg)`, `fx2(lane, row, op, arg)` | The effect column; the second effect column (format 3) |
| `set_vol(lane, row, vol)` | The volume column's SET, with no note |
| `set_pan(lane, row, pan)` | The panning column's SET: 0–63 in format 2, a `dir(az, el)` in format 3 |
| `vol_fine(lane, row, delta)` | A one-shot volume change on the row's first tick (up when positive); at most 31 in format 2, 127 in format 3 |
| `vol_slide(lane, row, per_tick)` | A volume slide on every later tick (up when positive) |
| `glide(lane, row, pitch, speed)` | A tone portamento to the pitch (`G` with no instrument: no new attack) |
| `glide_speed(from, to, rows)` | The `G` speed that covers `from` → `to` in that many rows |
| `vibrato(lane, from, to, speed, depth)` | `H` on the rows from `from` up to `to`: the first states speed and depth, the rest continue it; a row that already has an effect is stepped round (the next one states them again), and a key-off ends it |
| `melody(lane, row, text, …)` | A line from a melody string (§8.4); returns the row after it |
| `occupied(lane, row)` | Whether anything is written on that row yet |
| `lanes()` | Every lane, in order |

### 8.4 Melody strings

`melody(lane, row, text, vol, vib, glide_rows, transpose, ring, map)` reads `text` as a run of tokens separated by spaces or line breaks:

| Token | |
|---|---|
| `D5:2` | The note D5, lasting 2 rows |
| `~F5:4` | Glide into F5 from the note before (no new attack), arriving in `glide_rows` rows |
| `r:3` | A rest of 3 rows: the note before is keyed off |
| `…@40` | This note's volume (else the `vol` argument, else none written) |
| `…v` | Vibrato from two rows into the note, when it lasts 4 rows or more (`vib: [speed, depth]`, default `[$7D, $14]`) |
| `…>` | A tie: no key-off after this note, even before a rest or at the end |
| `\|` | A bar line: an error unless the notes before it fill whole bars |

The last note is keyed off where the line ends, unless the song ends there. `transpose` adds steps to every note; `map` is a function every pitch passes through (`map: fn(p) => mirror(p, 'C4')` turns the line upside down); `ring: true` writes no key-offs at all, for bells and plucks.

```
melody(lead, at(9), """
  D5:2 Fp5:2 G5:2 A5:2 ~Cp5:6v |
  A5:3 G5:1 Fp5:4v D5:4v E5:2 |
  """, vol: 55)
```

### 8.5 Pitches and chords

| Builtin | |
|---|---|
| `note(name)`, `notes("C4 E4 G4")` | A pitch, or a list of them, from names |
| `note_name(pitch)` | The name of a pitch: `"Cp4"` |
| `degree(name)` | A degree name without a period, as its number: `degree("Bb")` is 26 in 31-TET |
| `period()` | Steps in one period (31 in 31-TET) |
| `word(pitch)` | The pitch's 4096-TET note word, as the pattern grid stores it |
| `midi(key)` | The step nearest a MIDI key (60 is C4), a tie going to the lower step — what a General MIDI drum map needs |
| `mirror(pitch, axis)` | The pitch reflected through the axis: `2 × axis − pitch` |
| `transpose(pitches, steps)`, `invert(pitches, axis)` | The same over a list |
| `dir(az, el)` | A position for a format-3 song, in degrees: azimuth 0 ahead, 90 right, 180 behind; elevation 90 straight up |
| `nearest_chord(prev, chord, lo, hi, n, need_root)` | The notes of `chord` that move least from the notes `prev` |

A **chord** is a record with `root` (a degree number) and `ivs` (its intervals in steps), and optionally a `name` for error messages: `{ root: degree("D"), ivs: [0, 10, 18, 25] }` is D 4:5:6:7 in 31-TET. `nearest_chord` returns `n` pitches (as many as `prev` has, unless given), ascending, every one within `lo`…`hi` and of the chord's pitch classes, covering as many of its classes as `n` allows — the root among them when `need_root` — and moving the least in total from `prev` note by note (what harmony textbooks call smooth voice leading). Ties go to the lower spelling. It is an error when no spelling fits.

## 9. General builtins

| Numbers | |
|---|---|
| `abs` `floor` `ceil` `round` `trunc` `sign` `sqrt` `exp` `log` `log2` `log10` | One number in, one out. `round` takes halves up, towards +∞ |
| `sin` `cos` `tan` `asin` `acos` `atan` `atan2(y, x)`, `PI` | Angles in radians |
| `min(…)`, `max(…)` | Of the arguments, or of one list |
| `clamp(x, lo, hi)` | `x` held within `lo`…`hi` |
| `db(decibels)` | The gain factor: `db(-6)` is about 0.5 |

| Lists | |
|---|---|
| `len(x)` | Items in a list, characters in a string, numbers in a range, fields in a record |
| `range(n)`, `range(a, b, step)` | `0..<n`, and `a..<b by step` |
| `list(x)` | A list from a range, a string (its characters), a list (a copy) or a record (its field names) |
| `repeat(value, n)` | A list of `n` copies |
| `push(xs, …)`, `pop(xs)`, `insert(xs, i, v)`, `remove(xs, i)` | Change a list in place |
| `slice(xs, a, b)`, `reverse(xs)`, `rotate(xs, n)`, `sort(xs, key)`, `unique(xs)`, `flatten(xs)`, `zip(a, b)`, `copy(x)` | New lists (`copy` copies records too, all the way down) |
| `map(xs, f)`, `filter(xs, f)`, `reduce(xs, f, initial)`, `any(xs, f)`, `all(xs, f)`, `sum(xs)` | |
| `contains(xs, x)`, `index_of(xs, x)`, `count(xs, x)` | Searches (in a string, `contains` and `index_of` find text) |

| Strings | |
|---|---|
| `str(x)`, `num(s)` | A value as text; text as a number (`"$80"` is 128) |
| `split(s, sep)`, `join(xs, sep)` | Without `sep`, `split` splits at spaces and line breaks |
| `replace(s, find, with)` | Every occurrence |
| `trim`, `upper`, `lower`, `starts_with`, `ends_with` | |

| Records and the rest | |
|---|---|
| `keys(r)`, `values(r)`, `has_key(r, k)`, `get(r, k, default)`, `merge(a, b)` | `merge` is a new record with `b`'s fields over `a`'s |
| `type(x)` | `"number"`, `"string"`, `"bool"`, `"none"`, `"list"`, `"record"`, `"range"`, `"function"`, `"lane"`, `"instrument"` |
| `print(…)` | A line in the build log |
| `error(message)`, `assert(condition, message)` | Stop the build with a message |

## 10. Randomness

`random()` and everything built on it draw from one stream, seeded by the song's `seed` (1 unless given) and restarted by `seed(n)`, so a program makes the same choices every time it is built; change the seed for another set. The stream is **Mulberry32**, which an implementation **MUST** follow exactly:

```
state ← seed (as an unsigned 32-bit integer)
next():
  state ← (state + 0x6D2B79F5) mod 2^32
  t ← state
  t ← imul(t xor (t >>> 15), t or 1)
  t ← t xor (t + imul(t xor (t >>> 7), t or 61))
  return ((t xor (t >>> 14)) >>> 0) ÷ 2^32
```

(`imul` is the low 32 bits of the product, `>>>` an unsigned shift.)

| Builtin | Draws |
|---|---|
| `random()` | A number in [0, 1) |
| `random_int(lo, hi)` | `lo + floor(random() × (hi − lo + 1))` |
| `chance(p)` | `random() < p` |
| `choose(xs)` | `xs[floor(random() × len(xs))]` |
| `choose_weighted(xs, weights)` | An item, each as likely as its weight |
| `shuffle(xs)` | A shuffled copy (Fisher–Yates from the last item down) |
| `seed(n)` | Restarts the stream at `n` |

`noise(a, b)` is not part of the stream: it is a fixed hash of two whole numbers into [−1, 1), the same every time it is asked, which is what lane jitter uses (§11):

```
t ← (imul(a + 1, 0x9E3779B1) xor imul(b + 7, 0x85EBCA6B)) >>> 0
t ← imul(t xor (t >>> 15), t or 1)
t ← t xor (t + imul(t xor (t >>> 7), t or 61))
return (((t xor (t >>> 14)) >>> 0) ÷ 2^32) × 2 − 1
```

## 11. Building

A build turns the score into a project in these steps:

1. **Compile.** Each lane's events in each cue become one pattern of 64 rows (rows past the cue's length stay empty). Patterns with identical bytes are shared, and a lane with nothing in a cue leaves that cue empty. Patterns are named `"<label> <section>"`, numbered when names repeat. Every cue shorter than 64 rows carries its length, and the last cue stops the song.
2. **Volumes.** Each volume a lane sets becomes `clamp(round(v × trim + round(noise(lane index, row in its pattern) × jitter)), 1, max)` — `max` being 63 in format 2 and 255 in format 3 — except that a volume of 0 stays 0. The jitter depends on the row's place in its pattern, not in the song, so a repeated phrase still shares one pattern.
3. **Pans.** Each lane with a `pan` gets `S $8xxx` on the song's first row, in a pattern of its own when its first pattern is used anywhere else.
4. **Bank.** The instruments' presets are built into a bank by Microtone's soundfont converter, at the song's tempo (a soundfont's release times become fadeouts per tick).
5. **Instruments.** `layers`, `nna` and `fadeout` are applied.
6. **Cleanup.** Every zone of every instrument that no note in the song can reach is removed with its samples, as Housekeeping does — and, when `layers` left some layers behind, every instrument nothing plays.
7. **Adjustments.** `min_fadeout`, then `layer_gain`.
8. **Re-tuning** (when the song asks for it). Soundfont samples are tuned for twelve-tone music, a few cents either way — nothing in a piano, a fifth of a step in 31-TET. For each combination of zones the song's notes trigger, a held note is rendered, its pitch measured, and those zones' detune moved by the error; three passes, so the last measures the result. Layers a note sounds together move together, so a deliberately detuned pair keeps its spread.
9. **Source.** The program itself is saved in the project, in a `PMtf` section (TAUD_FILE_FORMAT.md §9.14), so that the Motif view can show it, and build it again.

The project is new and unsaved when the build finishes; save it like any other.

### In Microtone

The **Motif** tab (Shift+F7) holds a program and builds it. When the open project was built by Motif, the tab shows its program; otherwise it holds a draft of your own, kept in the browser. **Build** (Ctrl+Enter) runs the program away from the page, so a long one never freezes the app, and **Cancel** stops it. An error stops the build and is shown with its line and column — click the position to go there — and, inside a function, the calls that led to it. Opening a `.tml` file anywhere a project can be opened puts it in the tab and builds it.

### On the command line

From `microtone-worker/` in Microtone's source:

```
node tools/motif.js song.tml [out.taud] [-v] [--check] [--no-source]
```

`--check` runs the program and compiles the song without making the bank, and says what it would make; `--no-source` leaves the program out of the project. The bank is made by the same converter the app runs, with the local `python3`.

## 12. Limits and errors

| Limit | |
|---|---|
| Steps | 50 000 000 — each statement and each expression evaluated is a step |
| Calls | 200 deep |
| Nesting | 200 deep in the source |
| Lists and strings | 1 000 000 items or characters |
| Source | 2 MiB |
| Lanes, instruments | 64, 255 |

Every error names its line and column, and a mistake inside a function also lists the calls that led to it, innermost first. Errors are written to be acted on: a misspelt option suggests the one that was probably meant; a clash names the lane, the bar, the row and both values; a bar line that falls mid-bar says how many rows in it falls.

## 13. Version history

| Version | Date | |
|---|---|---|
| 1 | 2026-10-11 | The first version |
