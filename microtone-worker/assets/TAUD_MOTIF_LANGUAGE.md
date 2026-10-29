# Taud Motif Language

**Motif** is Microtone's way of writing a song as a program. A Motif program — written in the **Taud Motif Language**, TML for short, and kept in a `.tml` file — describes the music itself (notes, melodies, chords, instruments, the arrangement) and the rules that make it (functions, probability, transformations). Building the program makes a whole Taud project: the patterns and cues, an instrument bank drawn from a soundfont, the mix, the mastering chain and the texts. The project carries its program, so it can be opened in the Motif view, changed and built again.

TML is **declarative**: a program says what the song is, not what to do in which order. Music is a value that can be named, passed, transformed and combined; every line on its own is part of the song; a name can be used anywhere in the block that defines it; and nothing, once made, changes. So a program can be read, and rearranged, in any order, and the song it builds stays the same.

TML is a small language of its own rather than JavaScript, so that a program can be shared and built by anyone without being trusted: it can reach nothing but the builtins listed here — not the page, the network, the files or the clock — and it runs on a budget of steps, so the worst a program can do is fail to build.

Companion documents: the **Taud File Format** defines the project a build writes, and the **Note Effects** reference what the effect letters in a program mean.

- **Created** by CuriousTorvald, 2026-10-11. Language version 2; programs written in version 1 still build, as §13 describes.
- **Files** — UTF-8 text with the extension `.tml`, at most 2 MiB.
- **Determinism** — the same program, built against the same soundfont by the same version of Microtone, makes the same project byte for byte, in the app and on the command line alike. Nothing in a program depends on the time, the machine, or chance that is not keyed to the song's seed.

## Conformance language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold.

## 1. A first program

```
tml 2
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

// A kick on every bar, and on a coin toss a second one.
let KICK = hit(kick, 0, midi(36), 50)
for bar in 1..3 {
  shift(KICK, at(bar))
  if chance(0.5, "second kick", bar) { hit(kick, at(bar, 10), midi(36), 36) }
}
```

Line by line: every program starts with `tml` and the language version. The `song` block says what the song is — its tuning, tempo and length. Each `instrument` is a preset of the soundfont, and each `lane` is one of the song's monophonic parts, playing an instrument. The rest is the music. `melody` is a line written as a string of notes (§8.4). `KICK` names a single kick drum, which is music like any other; the `for` places it on the first row of every bar, and on a coin toss adds a second kick. The coin is keyed to what it is for — the second kick of that bar — and to the song's seed (§10), so the same program always tosses it the same way.

## 2. How a program is read

A program is made of **definitions** — the song and its parts (`song`, `instrument`, `lane`, `section`, `master`), values (`let`) and functions (`fn`) — and **music**. A value can be a number, a list, a record, a function — or a **phrase**: music, the notes and effects a part of the song plays (§8.2). Every line on its own (a call, usually) is a piece of music, and the song is every piece of music the program's lines make, put together.

Three rules make a program declarative:

- **Order does not matter.** A name can be used anywhere in the block that defines it, above its own line as well as below, and the song's music is put together by rules (§8.2) that give the same result whatever order its pieces come in. The song's declaration can come last, its instruments after its lanes, and its helper functions before or after the music that uses them.
- **Nothing changes.** A name keeps the value it is given; lists and records are never changed, only used to make new ones. There is no assignment and no loop that runs "until": a value that a TML 1 program would build step by step is built in one go (a comprehension, `map`, `scan`).
- **Music is a value.** The event builtins (`hit`, `melody`, `keyoff`…) do not write anything anywhere: they *make* music, which a program can name, move, repeat, transform and combine before it becomes part of the song.

Some music can only be placed once the rest of the song is known: a vibrato that steps round the effects of its lane, a volume ramp that steps round the volumes, music placed `under` the rest or made to `follow` another lane. These are **fitted** parts (§8.6). A build places the song in two passes: every cell that is placed for certain, then each fitted part against those.

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
let ABOUT = """
  First paragraph.

  Second paragraph.
  """
```

reads `"First paragraph.\n\nSecond paragraph."`.

### Pitches

`'…'` is a pitch: a note name in the song's tuning, such as `'C4'` or `'Cp4'` (§7.2). It is a number — a count of steps.

### Names and reserved words

A name is ASCII letters, digits and `_`, not starting with a digit; case matters. These words are reserved and cannot be names:

`tml` `let` `fn` `for` `in` `while` `if` `then` `else` `return` `break` `continue` `and` `or` `not` `true` `false` `none`

(`while`, `break` and `continue` belong to TML 1, §13.) `song`, `instrument`, `lane`, `chain`, `master` and `section` are declarations only at the start of a statement, and `by` only after a range, so all seven may still be used as names (`fn dr(lane, bar)` is fine).

## 4. Values

| Type | Written | Notes |
|---|---|---|
| number | `42`, `0.5`, `$7300`, `'D5'` | an IEEE 754 double |
| string | `"text"` | |
| bool | `true`, `false` | |
| none | `none` | the absence of a value |
| list | `[1, 2, 3]` | ordered; a trailing comma is allowed |
| record | `{ root: 2, ivs: [0, 10] }` | named fields in the order first written |
| range | `1..8`, `0..<14 by 2` | whole numbers, made on demand (§5) |
| function | `fn(x) => x * 2` | §6 |
| phrase | made by the music builtins | music: §8.2 |
| lane | declared by `lane` | fields `name`, `label`, `index`, `inst`, `trim` |
| instrument | declared by `instrument` | field `name` |

A record's fields are separated by commas or line breaks, and `{ name }` is short for `{ name: name }`. A field name may also be a string: `{ "pad 1": 3 }`.

No value ever changes. `xs + [v]` is a new list with `v` on the end, `with(xs, i, v)` a new list with item `i` replaced, and `merge(r, { f: v })` a new record with field `f` set.

**Truth.** `false`, `none`, `0` and `""` are false; every other value is true.

**Equality.** `==` compares numbers, strings and bools by value; lists, records and ranges by their contents; phrases by the cells they place for certain (and the very same fitted parts); and functions, lanes and instruments by identity.

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

**Comprehensions** make a list in one go: `[n * 2 for n in 1..4]` is `[2, 4, 6, 8]`. A `for` may be followed by any number of `if` conditions, which keep only the items they are true for, and by further `for`s, which run inside it: `[[x, y] for x in 0..<3 for y in 0..<x if x + y > 1]`. `for i, x in xs` gives the index (a record: the field's name) as well. The element is written first, but the names its `for`s bind are its own.

**Calls** take positional arguments, then named ones: `melody(lead, at(9), THEME, vol: 55)`. A named argument names a parameter.

**Function values** are written `fn(x, y) => expression` or `fn(x, y) { statements }`.

## 6. Statements and blocks

| Statement | |
|---|---|
| `let name = value` | a name for a value; `let [a, b] = pair` unpacks a list |
| `fn name(a, b = 2) => expression` | a function whose value is the expression |
| `fn name(a, b = 2) { … }` | a function with a body of statements (below) |
| `if c { … } else if d { … } else { … }` | `else` may start the line after the closing brace |
| `for x in xs { … }` | the body for each item of a list or range, each character of a string |
| `for x in xs if c { … }` | only for the items `c` is true for |
| `for i, x in xs { … }` | with its index (a record gives each field's name and value) |
| `for [a, b] in pairs { … }` | unpacking each item |
| `{ … }` | a block: a scope of its own for the names it defines |
| `return value` | ends a function, with that value (`return` alone: none) |
| an expression | music: a phrase, a list of phrases, or none |

The body of a function, a branch of an `if`, the body of a `for` and a bare `{ }` are **blocks**. The top of the program is a block too, and the only place a declaration may stand (§7).

**Names.** Every name a block defines — its `let`s and `fn`s, and at the top its lanes and instruments — can be used anywhere in that block, and in every block and function inside it, above its own line as well as below. A name is defined once per block (an inner block may define the same name again, for itself). When a block runs, each of its `let`s is computed in the order written, each after whatever it needs; a value defined in terms of itself (`let x = x + 1`, or two names defined in terms of each other) is an error.

**Music.** Every statement of a block that is an expression must make music — a phrase, a list of phrases, or none (`print(…)` and `assert(…)` make none) — and the block's music is all of it put together (§8.2). A value that is not music, on a line of its own, is an error: nothing would use it. An `if` makes the music of the branch it takes; a `for` makes the music of every round put together.

**Functions.** A parameter may have a default, written after the ones without, which may use the parameters before it: `fn f(a, b = a * 2)`. A function sees the names around the place it was written. A function written with `=>` gives the value of its expression. A function with a body gives the music its body makes — together with the phrase it returns, if it returns one — or, when its body makes no music, the value it returns. A body that makes music and returns something else is an error.

**Blocks after conditions.** The `{` after the condition of `if` and after the list of `for` (or its `if` condition) starts the block, so a record written there needs parentheses: `for k, v in ({ a: 1 }) { … }`.

**What TML 2 leaves out.** TML 1 (§13) had statements that changed things, and a program that uses them is told what to write instead:

| TML 1 | TML 2 |
|---|---|
| `x = x + 1`, `x += 1`, `xs[i] = v`, `r.f = v` | a new name: `let y = x + 1`, `with(xs, i, v)`, `merge(r, { f: v })` |
| a value built up in a loop | a comprehension, `map`, `filter` or `scan` |
| `while c { … }` | a `for` over a range, or a function that calls itself |
| `break`, `continue` | `for x in xs if c { … }`, or an `if` |
| `push`, `pop`, `insert`, `remove` | `xs + [v]`, `xs[0..<len(xs) - 1]`, slices joined with `+` |
| `seed(n)` and the random stream | keyed randomness (§10) |
| `occupied(lane, row)`, `cell(lane, row)` | `under`, `follow` (§8.6); `occupied`, `cell` and `cells` of a phrase (§8.7) |

## 7. Declarations

Declarations stand at the top of the program, never inside a block or a function: each says what the song is. They may come in any order. The song is read first, then the master, the mixing chains, the instruments, the lanes and the sections; lanes are numbered, and instruments take their slots, in the order they are written.

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
| `surround` | `"stereo"` | `"stereo"`, `"planar"` (the circle) or `"spatial"` (the sphere) |
| `format` | 2; 3 for a surround song | 3 is the wide cell (TAUD_FILE_FORMAT.md §5.5), for surround songs only |
| `global_volume`, `mixing_volume` | 128, 128 | The song's two volumes, 0–255 |
| `seed` | 1 | The seed every random choice is keyed to (§10) |
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
instrument EP   { bank: 0, program: 4, layer_gain: 3 }
instrument SINE { wave: "sine", envelope: [[0, 63], [0.4, 30], [2, 0]] }
instrument BELL { fm: { operators: [{ inst: SINE }, { inst: SINE, ratio: 3.5, level: -6 }], algorithm: "0[1]" } }
instrument HAT  { opl: { kind: "hi_hat", operators: [{ decay: 10, sustain_level: 15, sustain: false, release: 10 }] } }
instrument BUZZ { psg: { a: { waveform: "pulse2", decay: 6, sustain_level: 15, sustain: false } } }
instrument KA   { formant: { syl_ipa: "kʰa" }, chain: ROOM }
```

Declaring an instrument binds its name. A song has at most 255. Each has exactly one **source**:

| Source | Options | |
|---|---|---|
| A soundfont preset | `bank`, `program` | Bank 0–128 (128 holds the drum kits), program 0–127, from the song's `soundfont` |
| An instrument pack | `pack`, `slot` | An instrument of a `.tsii` bank (or a whole `.taud` project): `pack` names the file, `slot` the instrument's slot number in it or its name there. The app asks for the file the first time a build needs it; the command line finds it next to the `.tml` |
| A waveform | `wave`, `length` | One cycle of `"sine"`, `"triangle"`, `"saw"`, `"square"`, `"noise"` or one of OPL's eight (`"opl0"` … `"opl7"`), `length` samples long (256 unless given), looped and tuned so C4 sounds at C4 — the Sample Lab's paint presets |
| Layers | `layers` | A layered metainstrument: a list of layers over other instruments, each sounding on its own voice (below) |
| An FM rack | `fm` | An FM operator rack: operators reading other instruments, combined by an algorithm, on one voice (below) |
| An OPL chip | `opl` | One channel of a Yamaha YM3812 / YMF262 FM chip, sounding where a sample would: its kind, its connection and its operators, as the Instruments view's OPL tab sets them (below) |
| A PSG chip | `psg` | Two programmable-sound-generator oscillators, added or multiplied, sounding where a sample would, as the Instruments view's PSG tab sets them (below) |
| A sung syllable | `formant` | A formant instrument: consonants, a vowel and a consonant spoken on the key-off, sung through a model of the vocal tract — written in the IPA, in X-SAMPA or field by field, as the Instruments view's Formant tab sets it (below) |

Every instrument also takes:

| Option | Default | |
|---|---|---|
| `name` | the soundfont's or pack's name; else the instrument's own | The instrument's name in the project |
| `retune` | `true` for soundfont presets and layers, `false` otherwise | Whether the song's `retune` measures this instrument — drums and noises are better left out, and a waveform is in tune already |
| `layer_gain` | — | (A layered preset from a soundfont or a pack.) Decibels applied to every one of its layers, as the layer-mix octet that comes nearest (TAUD_FILE_FORMAT.md §7.10) |
| `keep_layers` | all | (The same.) Which of its layers to keep, numbered from 0; the others are removed |
| `min_fadeout` | — | Every zone fades out at least this fast (in the engine's fadeout units, which a soundfont's release becomes at the song's tempo) |
| `fadeout` | — | Every layer and zone fades out at exactly this rate |
| `nna` | — | The New Note Action: `"off"`, `"cut"`, `"continue"` or `"fade"` |
| `envelope` | — | (A waveform, an OPL, a PSG or a formant instrument.) Its volume envelope: up to 25 `[seconds, volume]` points, volume 0–63, the last held; at most 15.75 s between two points |
| `sustain` | — | (One with an envelope.) The point it holds while the key is down (`sustain: 1`), or a range of points it loops through (`sustain: 1..3`) |
| `percussion` | `false` | (Layers, an FM rack, an OPL, a PSG or a formant instrument.) Marks the instrument as percussion |
| `strict` | `false` | (Layers.) Strict layering: a layer whose own zones do not cover a note stays silent for it, rather than falling back to its base sample (TAUD_FILE_FORMAT.md §7.5) |
| `chain` | none | Its mixing chain (§7.7): a chain declared with `chain NAME { … }`, which instruments share, or a record of the same pieces, a chain of its own |

**Layers.** Each layer is a record:

| Field | Default | |
|---|---|---|
| `inst` | — | **Required.** The instrument it sounds |
| `gain` | 0 | Its level, in decibels |
| `detune` | 0 | Its detune, in cents |
| `notes` | every pitch | The pitches it answers: a range such as `'C3'..'C5'` |
| `vols` | 0..63 | The volumes it answers (0–63) |
| `fixed` | — | A pitch it always plays, whatever note triggers it — a click, a breath, a noise bed (no `detune` then) |

A layer over a layered instrument stands in for all of that instrument's layers (a layer cannot hold a metainstrument): each keeps its own layer, with the two gains and the two detunes added and the two ranges narrowed to where they overlap. So `layers: [{ inst: PIANO }, { inst: STRINGS, gain: -6 }]` stacks two soundfont presets whatever they are made of. A metainstrument holds at most 25 layers.

**FM racks.** `fm` is a record of `operators` — a list of 1–16 — and an `algorithm`. Each operator is a record:

| Field | Default | |
|---|---|---|
| `inst` | — | **Required.** The instrument it reads: one sample or one chip — a `wave`, usually, or an `opl` or `psg` instrument — not a metainstrument, nor a formant instrument |
| `level` | 0 | Its output level, in decibels |
| `ratio` | 1 | Its frequency ratio: 2 an octave up, 3.5 a minor seventh above that |
| `detune` | 0 | Added to the ratio, in cents |
| `notes`, `vols` | everything | The pitches and volumes it plays for; outside them it is silent (key scaling, velocity-switched brightness) |

The algorithm is written the way the Instruments view's FM tab reads one back: `0` is operator 0 free-running; `0[1]` is operator 0 with its phase modulated by operator 1, so `0[1[2]]` is a chain of three; `1'` is what operator 1 put out one sample before (a feedback tap, so `0[0']` is operator 0 feeding back into itself); `a + b` mixes, `a * b` ring-modulates, `-a` inverts, and parentheses group. Without one, the rack is a chain: the last operator into the one before it, all the way down to operator 0. Operator 0 is the principal — its envelope, its fadeout and its ending are the note's (TAUD_FILE_FORMAT.md §7.7). An algorithm that does not make a playable rack is an error.

**OPL instruments.** `opl` is a record of the chip channel's settings and its `operators`, every one a register value the OPL tab edits ([TAUD_FILE_FORMAT.md §7.8](TAUD_FILE_FORMAT.md)):

| Field | Default | |
|---|---|---|
| `kind` | `"2op"` | `"2op"` or `"4op"`, or one of the chip's five rhythm-mode drums: `"bass_drum"`, `"snare"`, `"tom"`, `"cymbal"`, `"hi_hat"` |
| `operators` | — | **Required.** Two for a `2op` and a `bass_drum`, four for a `4op`, one for every other drum (below) |
| `connection` | `"fm"` | (`2op`, `bass_drum`.) `"fm"`: operator 1 bends operator 2's phase and only operator 2 is heard; `"additive"`: both are heard. (`4op`.) One of the OPL tab's four, `"1>2>3>4"`, `"1>2+3>4"`, `"1+2>3>4"` or `"1+2>3+4"` — an arrow (`>`, `->` or `→`) is one operator bending the next, a plus two heard side by side — or its place in that list, 0–3 |
| `feedback` | 0 | (`2op`, `4op`, `bass_drum`.) 0–7: how much operator 1 bends its own phase |
| `deep_tremolo`, `deep_vibrato` | `false` | Tremolo of 4.8 dB instead of 1 dB, vibrato of 14 cents instead of 7, for the operators that have them |
| `note_select` | `false` | Which bit of the pitch key-scale rate follows (the chip's NTS) |
| `low_fnum` | `false` | Drive the chip with F-numbers 343…685 a block, as the SOP player does |
| `partner_multiple` | 1 | (`snare`, `cymbal`, `hi_hat`.) The multiple of the partner operator whose phase the drum mixes in |
| `partner_pitch` | 700 for a `cymbal`, −700 for a `hi_hat` | (`cymbal`, `hi_hat`.) How far, in cents, the partner's channel sits from the drum's own pitch |

Each operator is a record:

| Field | Default | |
|---|---|---|
| `multiple` | 1 | The operator's frequency as a multiple of the note, 0–15: 0 is a half, then 1 to 10, 12 and 15 (11 plays as 10, 13 as 12, 14 as 15) |
| `level` | 0 | Total level, as attenuation, 0–63: 0 the loudest, each step 0.75 dB quieter. On a modulator it sets how hard it bends |
| `attack`, `decay`, `release` | 15, 0, 7 | Rates, 0–15: 0 never, 15 at once |
| `sustain_level` | 0 | Where the decay stops, 0–15: 0 at the peak, each step 3 dB lower, 15 at −93 dB |
| `sustain` | `true` | Hold at the sustain level while the note is held; `false` lets the release follow the decay at once — what a drum wants |
| `waveform` | 0 | 0 sine, 1 half sine, 2 rectified sine, 3 quarter-sine pulses; 4–7 the OPL3's alternating sine, camel sine, square and logarithmic saw |
| `tremolo`, `vibrato` | `false` | The chip's 3.7 Hz tremolo and 6.1 Hz vibrato |
| `key_scale_level` | 0 | How much quieter higher notes are, in the chip's order: 0 none, 1 3 dB per octave, 2 1.5 dB, 3 6 dB |
| `key_scale_rate` | `false` | Make the envelope quicker on higher notes |

So an operator written `{}` is a sine at full level, held while the note is, that speaks at once and lets go within a second.

```
instrument ORGAN { opl: { kind: "4op", connection: "1+2>3+4", operators: [
  { multiple: 1 }, { multiple: 4, level: 30, decay: 5, sustain_level: 7 },   // 8', and a click on the 4'
  { multiple: 2, level: 5 }, { multiple: 3, level: 10 },                      // 4' and 2⅔'
] } }
instrument KICK { opl: { kind: "bass_drum", feedback: 4, operators: [
  { multiple: 0, level: 18, decay: 8, sustain_level: 15, sustain: false },
  { decay: 7, sustain_level: 15, sustain: false, release: 10 },
] } }
```

**PSG instruments.** `psg` is a record of the mixer and the two oscillators, `a` and `b` ([TAUD_FILE_FORMAT.md §7.9](TAUD_FILE_FORMAT.md)):

| Field | Default | |
|---|---|---|
| `a`, `b` | — | The two oscillators (below); at least one. An oscillator left out is muted |
| `mix` | `"additive"` | `"additive"`, A + B, or `"multiplicative"`, A × B taken as 0-to-1-volt signals |
| `mute_a`, `mute_b` | `true` for one left out | Leave an oscillator out of the mix. It keeps running, so `S $AF00` brings it back where it would have been |

Each oscillator is a record of an OPL operator's `multiple`, `level`, `attack`, `decay`, `sustain_level`, `release`, `sustain`, `key_scale_level` and `key_scale_rate`, with the same meanings and defaults, and:

| Field | Default | |
|---|---|---|
| `waveform` | `"pulse4"` | 0–15, or by name: `"dc"`; `"pulse1"` … `"pulse7"`, low for that many eighths of the cycle (`"pulse4"` the square); `"saw"`, `"triangle"`; the 1-bit noises `"noise32767"`, `"noise2047"` and `"noise127"` (white to metallic), clocked sixteen steps a cycle, so the note sets their colour; `"saw4"` and `"triangle4"` on sixteen levels; `"silence"` |
| `tremolo`, `vibrato` | 0 | Depth 0–2: tremolo of 1 dB or 4.8 dB at 3.7 Hz, vibrato of 7 or 14 cents at 6.1 Hz |
| `invert` | `false` | Turn the waveform over within its 0…1 V |
| `reset` | `false` | Start the oscillator afresh at every note — its phase, its noise, its auto-advance and its tremolo and vibrato — rather than running on from the note before |
| `advance` | 0 | Auto-advance, in quarter ticks, 0–255: a pulse takes the next step of its pattern every this many (4 is once a tick); 0 is off, and only the pulses advance |
| `pattern` | 0 | Which of the four auto-advance patterns it walks, 0–3 |

```
instrument SUB   { psg: { a: { waveform: "triangle4" } } }                    // the Famicom's triangle
instrument CLOCK { psg: { mix: "multiplicative",                               // ring modulation
  a: { waveform: "triangle", decay: 7, sustain_level: 15, sustain: false, reset: true },
  b: { waveform: "pulse4", multiple: 3, decay: 6, sustain_level: 15, sustain: false, reset: true },
} }
```

An OPL or a PSG instrument holds no sample and is in tune as it is, so `retune` leaves it alone unless asked. It may be a layer and an FM operator. Its New Note Action is `"cut"` unless given, and a chip note cut by a note of the same chip is not cut at all: the next note keys the same channel on again from wherever its envelopes stand, as on the chip itself. `nna: "off"` lets the old note go into its release on a voice of its own instead, so notes on one lane overlap; `"continue"` leaves a held note sounding for good.

**Formant instruments.** `formant` is a record saying the **syllable** a note sings and what it is sung **with** ([TAUD_FILE_FORMAT.md §7.6](TAUD_FILE_FORMAT.md)). A note says up to two consonants (the **onset**), an optional **glide**, then holds the **vowel** — nasalised or r-coloured if asked — for as long as the key is down; a key-off speaks the **coda**, one consonant, and ends the note. A syllable may have no vowel: then the last onset consonant is held in its place — a hummed [ŋ̍], a long [s̩].

The syllable is written as text, in either of two alphabets, or field by field, or both — each field given by name overriding what the text says:

| Field | Default | |
|---|---|---|
| `syl_ipa` | — | The syllable in the IPA, as the Formant tab spells it: `"kʰa"`, `"[pʲa]"`, `"tɔ̃k̚"`, `"n̩"` (below) |
| `syl_sampa` | — | The same in X-SAMPA: `"k_ha"`, `"p_ja"`, `"tO~k_}"`, `"n="`. One of the two, not both |
| `source` | `"saw"` | What the vowel is sung with: a waveform (one of the `wave` names), a single cycle of which becomes the instrument's own sample; or an `opl` or `psg` instrument, whose voice is sung in place of a sample — the instrument then takes nothing from the sample pool, and its consonants' noise is the engine's noise generator |
| `onset` | the syllable's | A list of up to two consonants, each an IPA string (`"s"`, `"t͡ʃ"`), a consonant id (TAUD_FILE_FORMAT.md §7.6), or a record `{ consonant, tilt, gain }`: `tilt`, −128…127, brightens (above 0) or darkens the consonant's noise, `gain` (dB) sets its level. `[]` or `none` for no onset |
| `coda` | the syllable's | One consonant, as for `onset`, or `none` |
| `vowel` | [a] | A vowel of the chart as IPA (`"ɛ"`, `"ɑ̃"`, `"ɚ"`), its tongue and lips as `[front, open, round]` (each 0–255: back 0 to front 255, close 0 to open 255, spread 0 to rounded 255), or `none` for no vowel |
| `front`, `open`, `round` | the vowel's | One coordinate of the vowel, 0–255, given alone |
| `nasalised` | `false` | The vowel said with the velum lowered, as French [ɑ̃] |
| `r_coloured` | `false` | The vowel coloured with an r, as American English [ɚ] |
| `glide` | the syllable's | The semivowel between the onset and the vowel: `"j"`, `"ɥ"`, `"ɰ"`, `"w"` or `none` |
| `secondary` | the syllable's | A second gesture on the onset's last consonant: `"none"`, `"palatalised"` (ʲ), `"velarised"` or `"pharyngealised"` (ˠ, ˤ — the same dark tongue), `"glottalised"` (ˀ) |
| `coda_release` | the syllable's | How the coda lets go: `"released"`, `"unreleased"` (◌̚), `"velarised"` or `"pharyngealised"`, `"glottalised"` |
| `size_follows_pitch` | 0.25 | How far the formants rise with the note, as a power of its pitch (0–0.996); 0 keeps one size at every pitch |
| `reference` | C3 (the note word `$4000`) | The pitch at which the vowel chart's formants (a man's) are sung exactly. A syllable with no vowel has none |
| `consonant_length` | 1 | Every consonant's timing, longer or shorter: 2 is twice as slow, 0.5 twice as quick (0.25–3.96) |
| `vowel_glide` | 40 | How long, in milliseconds, `S $Afgr` takes to move the vowel (0–510, in steps of 2) |

With neither a syllable nor a field, a formant instrument sings [a]. Its New Note Action is `"off"`, and the next note on its lane, whatever plays it, keys off every syllable of it still singing there — each speaks its coda as the next begins; its fadeout is the Formant tab's 256. `nna` and `fadeout` change those. It sings at the note's own pitch, so it has nothing to `retune`. It may be a layer, but never an FM operator: it is a sound made out of a source rather than one.

**Writing a syllable.** A syllable is up to two consonants, a glide, one vowel and one consonant — every part but the vowel optional — written with the letters the Formant tab's charts show:

- **Consonants** are the tab's: [p b t d ʈ ɖ c ɟ k ɡ q ɢ ʔ]; the aspirated and breathy [pʰ tʰ kʰ ʈʰ bʱ dʱ ɖʱ ɡʱ sʰ]; the nasals [m ɱ n ɳ ɲ ŋ ɴ]; the trills [ʙ r ʀ]; the taps [ⱱ ɾ ɽ]; the fricatives [ɸ β f v θ ð s z ʃ ʒ ʂ ʐ ç ʝ x ɣ χ ʁ ħ ʕ h ɦ ɬ ɮ ɕ ʑ ʍ]; the approximants [ʋ ɹ ɻ j ɰ w ɥ l ɭ ʎ ʟ]; and the affricates, written with a tie bar — [t͡s d͡z t͡ʃ d͡ʒ t͡ɕ d͡ʑ ʈ͡ʂ ɖ͡ʐ p͡f k͡x c͡ç ɟ͡ʝ t͡θ d͡ð ɡ͡ɣ ʔ͡h] — or as the ligatures ʦ ʣ ʧ ʤ ʨ ʥ. Without a tie, [ts] is two consonants, [t] then [s]. A plain `g` is [ɡ]; a voiced stop written aspirated ([dʰ]) or with the breathy mark ([d̤]) is the breathy [dʱ].
- **Vowels** are the chart's marks: [i y ɨ ʉ ɯ u ɪ ʏ ʊ e ø ɘ ɵ ɤ o ə ɛ œ ɜ ɞ ʌ ɔ æ ɐ a ɶ ɑ ɒ]. ◌̃ after one nasalises it (as do ã ẽ ĩ õ ũ ỹ), ˞ r-colours it, and [ɚ] and [ɝ] are [ə] and [ɜ] r-coloured. A syllable has one vowel; a diphthong is a vowel moved with `S $Afgr`.
- **The glide** is [j], [ɥ], [ɰ] or [w] straight before the vowel: `"kwa"`, `"sja"`. Anywhere else, or with a mark of its own, it is a consonant.
- **Marks** after the onset's last consonant: ʲ palatalised; ˠ or ˤ velarised or pharyngealised; ˀ glottalised (and ◌͈, as Korean's tense consonants are written). [ɫ] is a velarised [l]. After the coda: ◌̚ unreleased, and ˠ ˤ ˀ as for the onset.
- **No vowel**: the consonant held in the vowel's place carries the syllabic mark, ◌̩ or ◌̍: `"n̩"`, `"ŋ̍"`, `"sŋ̍"`, `"t͡ʃ̩"`.
- Square brackets or slashes around the syllable are allowed and ignored. Length (ː), stress (ˈ) and syllable breaks are not: a note is one syllable, as long as it is held.

**X-SAMPA** is read into the IPA first, by its own chart (J. C. Wells, 1995): `_` before a diacritic attaches it — `_h` ʰ, `_t` breathy, `_j` or `'` ʲ, `_G` ˠ, `_?\` ˤ, `_e` velarised or pharyngealised, `_}` ◌̚, `~` or `_~` nasalised, `=` or `_=` syllabic — and anywhere else ties two letters into an affricate: `t_S` is [t͡ʃ], `k_x` [k͡x], `?_h` [ʔ͡h]. A grave accent after a vowel r-colours it — `@` and `3` followed by one are [ɚ] and [ɝ] — and after `t d n r s z l r\` it makes the consonant retroflex. X-SAMPA has no mark for glottalisation, so Motif reads `_?` as one (`"s_?al"`, Korean 쌀).

```
instrument KA   { formant: { syl_ipa: "kʰa" } }                               // sung from a saw
instrument HUM  { formant: { syl_sampa: "N=", source: BUZZ }, nna: "fade" }   // a hummed [ŋ̍], sung from a PSG
instrument KUK  { formant: { syl_ipa: "kuk̚", consonant_length: 0.8 } }        // Korean 국
instrument AIR  { formant: { onset: [{ consonant: "s", tilt: 40 }], vowel: [255, 0, 0], round: 120,
  coda: "n", nasalised: true, reference: 'A3' } }
```

**Slots.** A build gives each instrument its slot: the soundfont presets first (1, 2, … in the order they are written), then the instruments from packs, the waveforms, the OPL and PSG instruments, the formant instruments and the metainstruments, each in the lowest slot free. An instrument used only as a layer or an operator still has a slot of its own.

### 7.4 `lane`

```
lane bass { inst: FRETLESS, pan: $80, label: "Fretless", trim: 0.8 }
```

A lane is one of the song's monophonic parts; declaring one binds its name. Lanes are numbered in the order they are written, at most 64 (more than 32 makes a 64-lane project).

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

Names part of the arrangement: every cue that starts in those bars names its patterns `"<lane label> <section>"`, so the Timeline reads "Lead theme", "Bass theme 2". Bars may be given as `9..16` or `9..<17`. A cue in no section names its patterns after the lane alone; a cue in two takes the first written.

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

### 7.7 `chain`

```
chain ROOM { name: "Room", mode: "bus", reverb: { size: 0.7, decay: 2.5, mix: 0.3 }, compressor: { threshold: -20, ratio: 4 } }
instrument PAD  { bank: 0, program: 89, chain: ROOM }
instrument LEAD { wave: "saw", chain: { tape_delay: { time_ticks: 12, feedback: 0.4 }, limiter: {} } }
```

A **mixing chain**: the equipment an instrument's sound goes through on its way to the master, as the Instruments view's Mixing tab builds it ([TAUD_FILE_FORMAT.md §9.15](TAUD_FILE_FORMAT.md)). Declaring one binds its name, which an instrument's `chain` takes; every instrument naming it is on the same chain. A record given to `chain` straight away is a chain of that instrument's own. The pieces always run in the chain's fixed order — input trim, equaliser 1, dynamic EQ 1, transient shaper 1, compressor, equaliser 2, dynamic EQ 2, unison, saturator, tape delay, reverb, limiter, mix tool — whatever order they are written in. A piece written is in the chain, starting from the settings the Mixing tab inserts it with; a piece not written is not in it.

| Option | Default | |
|---|---|---|
| `name` | the declared name (none for a record given to an instrument) | The chain's name in the project |
| `on` | `true` | The whole chain switched in; `false` leaves the instruments sounding as if they had none |
| `mode` | `"separate"` | `"separate"`: every instrument on the chain runs its own copy of it. `"bus"`: their sounds are summed and the chain runs once over the sum, as a group bus on a desk |
| `order` | `"delay_reverb"` | Whether the tape delay feeds the reverb or, `"reverb_delay"`, the reverb feeds the delay |
| the pieces | — | `input_trim`, `equaliser_1`, `dynamic_eq_1`, `transient_shaper_1`, `compressor`, `equaliser_2`, `dynamic_eq_2`, `unison`, `saturator`, `tape_delay`, `reverb`, `limiter`, `mix_tool`: a record each (below) |

Every piece takes `on` (default `true`; `false` keeps it in the chain, bypassed), and the transient shaper, compressor, unison, saturator, tape delay and reverb take `mix`, 0–1: how much of the processed sound replaces the dry one. Each value must lie in the range the Mixing tab offers for it; one outside it is an error. Gains and levels are in dB, frequencies in Hz and times in milliseconds, unless the field says ticks: a time in ticks follows the tempo, in quarter-tick steps.

| Piece | Fields (defaults: the Mixing tab's) |
|---|---|
| `input_trim` | `gain` |
| `equaliser_1`, `equaliser_2` | `bands`: up to eight `{ shape, freq, gain, q, slope, on }`. `shape` (required) is `"high_pass"`, `"low_shelf"`, `"bell"`, `"high_shelf"`, `"low_pass"` or `"notch"`; `slope`, 12, 24, 36 or 48 dB per octave, is the two passes' alone. Without `bands`, the four flat bands the tab starts with |
| `dynamic_eq_1`, `dynamic_eq_2` | The six bands by name — `low_shelf`, `bell_1` … `bell_4`, `high_shelf` — each `{ freq, q, gain, threshold, ratio, attack, release, range, actor_gain, above, sensor_freq, sensor_q, on }`. A band written is on. `gain` is the static gain; `above`, `"cut"` or `"boost"`, is what the band does above the threshold, and `actor_gain` how strongly; `sensor_freq` or `sensor_q` lets it listen somewhere other than where it acts |
| `transient_shaper_1` | Either one band's `attack` and `sustain` (dB: what it does to a note's start and to its decay), `attack_time` and `sustain_time` (ms) and `output`, or `bands`, a list of one to six such records (with `on`), split at `crossovers` as the compressor's are |
| `compressor` | `detector` (`"peak"` or `"rms"`), then either one band's `threshold`, `ratio`, `attack`, `release`, `knee` and `make_up`, or `bands`, a list of one to six such records (with `on`), split at `crossovers` (Hz, rising, one fewer than the bands) |
| `unison` | `voices` (2–8), `detune` (cents), `width`, `spacing`, and `detune_lfo` and `width_lfo`, each `{ waveform, rate, period_ticks, depth, restart }`: `waveform` `"sine"`, `"triangle"`, `"square"`, `"saw_up"`, `"saw_down"` or `"random"`; `rate` in Hz, or `period_ticks` to follow the tempo; `restart` starts it again at each note |
| `saturator` | `curve` (`"tape"`, `"soft_clip"`, `"hard_clip"`, `"tube"`, `"wavefolder"`), `drive`, `input`, `output`, `bias` |
| `tape_delay` | `time` (ms) or `time_ticks`, `feedback`, `high_cut`, `low_cut`, `wow`, `drive`, `ping_pong` |
| `reverb` | `size`, `decay` (seconds), `damping` (Hz), `pre_delay` (ms) |
| `limiter` | `ceiling`, `release` (ms), `gain`, `true_peak` |
| `mix_tool` | `gain`, `width`, `swap`, `invert_left`, `invert_right`, `remove_dc` |

A chain no instrument names is not saved. The build numbers the chains in the order the instruments that use them are written, after any chain an instrument from a pack brought along, which an instrument's own `chain` replaces. An instrument heard only as a layer of a metainstrument goes through the metainstrument's chain, not its own.

## 8. Music

### 8.1 Rows

Music is placed by **row**, counted from 0 at the start of the song. `at(bar, row)` is the row of a bar (counted from 1) and a row within it (from 0): with 14-row bars, `at(9)` is row 112 and `at(9, 4)` row 116. Music always lies within the song: a row outside it is an error — except that a key-off, cut or fade which moving music (`shift`, `seq`, `loop`) pushes past the song's end is left out, as a melody leaves out the key-off it would write where the song ends: the song is over, and has nothing left to end.

### 8.2 Phrases, cells, and how music is put together

A **phrase** is a piece of music: the **cells** it writes, on lanes and rows, and the rows it spans, from its first row up to (not including) the row where it ends — a melody of eight two-row notes spans 16 rows, though the key-off after its last note lies on the row after. A cell is what one row of one lane holds: a note, an instrument, a volume-column command, a panning-column command and one effect (two in a format-3 song).

When phrases are put together — the lines of a block, or the arguments of `stack` — their cells **MERGE** row by row. Two cells that give one field two different values are a mistake in the program and stop the build, naming the lane, the bar and the row, with one exception: a note wins over a key-off, note cut or note fade on its row. So a phrase can end with a key-off on the row where the next phrase begins with a note. The volume column holds a volume or a command (a slide, a fine slide), not both: a note's volume and a slide on its row are a clash too.

These rules do not depend on the order phrases are put together in, so neither does the song.

### 8.3 The event builtins

Each makes a phrase: one row long, unless it says otherwise — a key-off, cut or fade lasts no rows, since it marks the moment a note ends. Volumes are 0–63 in a format-2 song and 0–255 in a format-3 one. An effect is its letter — `"G"`, `"S"` — or its symbol, and its argument a number written as on the grid: `fx(lane, row, "S", $7300)` is `S $7300`.

| Builtin | Makes |
|---|---|
| `hit(lane, row, pitch, vol, fx, arg, inst, pos, delay)` | A note with the lane's instrument (or `inst`), optionally its volume, an effect, a position (`pos: dir(az, el)`, format 3) and a delay of 1–15 ticks (`S $Dx`) |
| `keyoff(lane, row)`, `cut(lane, row)`, `fade(lane, row)` | Key-off, note cut, note fade |
| `fx(lane, row, op, arg)`, `fx2(lane, row, op, arg)` | The effect column; the second effect column (format 3) |
| `set_vol(lane, row, vol)` | The volume column's SET, with no note |
| `set_pan(lane, row, pan)` | The panning column's SET: 0–63 in format 2, a `dir(az, el)` in format 3 |
| `vol_fine(lane, row, delta)` | A one-shot volume change on the row's first tick (up when positive); at most 31 in format 2, 127 in format 3 |
| `vol_slide(lane, row, per_tick)` | A volume slide on every later tick (up when positive) |
| `glide(lane, row, pitch, speed)` | A tone portamento to the pitch (`G` with no instrument: no new attack) |
| `glide_speed(from, to, rows)` | (A number.) The `G` speed that covers `from` → `to` in that many rows |
| `melody(lane, row, text, …)` | A line from a melody string (§8.4), spanning its notes and rests |
| `vibrato(lane, from, to, speed, depth)` | `H` on the rows from `from` up to `to`, fitted (§8.6): the first states speed and depth, the rest continue it; a row with another effect is stepped round (the next one states them again), and a key-off ends it |
| `vol_ramp(lane, from, to, from_vol, to_vol)` | A smooth change of the sounding note's volume over the rows from `from` up to `to`, fitted (§8.6): one fine slide a row, each the rounded share of what is left, in the lane's own units (its trim applies, as to a volume it sets); a row whose volume column is taken is stepped round |
| `lanes()` | (A list.) Every lane, in order |

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

### 8.5 Combining and transforming music

Wherever these take music, a list of phrases will do (it is put together first).

| Builtin | Makes |
|---|---|
| `stack(a, b, …)` | The phrases together, as the lines of a block are |
| `seq(a, b, …)` | The phrases one after another: each moved to start where the one before ends |
| `shift(music, rows)` | The music moved later (earlier, for a negative count) |
| `loop(music, times, every)` | The music `times` times, each `every` rows after the last (its own length, unless given) |
| `rest(rows)` | Nothing, lasting `rows` rows from row 0: a gap in a `seq`, or a bar's length for `loop` |
| `slice(music, from, to)` | The cells on rows from `from` up to `to` (the end of the music, unless given) |
| `on(lane, music)` | The music played on another lane. A note that played the instrument of the lane it came from plays the new lane's; a note given an instrument of its own keeps it |
| `transpose(music, steps)` | Every note moved by that many steps (glides too; their speeds stay) |
| `invert(music, axis)` | Every note reflected through the axis: `2 × axis − pitch` |
| `map_notes(music, f)` | Every note's pitch through `f(pitch)` |
| `map_vols(music, f)` | Every volume a cell sets through `f(volume)` |
| `filter(music, f)` | Only the cells `f(cell)` is true for (the cell as `cells` gives it, §8.7) |
| `reverse(music)` | The music backwards (retrograde): below |
| `stretch(music, factor)` | The music `factor` times as slow (augmentation; a factor below 1 is diminution), counted from its start: below |

`transpose`, `invert`, `filter`, `slice` and `reverse` take lists too, as §8.8 and §9 say. A transformation applies to a phrase's fitted parts as well, so a vibrato moved with its melody still steps round the effects where it now lies.

**Backwards.** A row of a lane is not a note: a note *sounds* from its row until something ends it, a glide carries the sound on to another pitch, and effects and volume commands act on it in between. So `reverse` turns round what the music does rather than its rows. On each lane, the sounds and the silences between them come in the opposite order, each as long as it was, and the phrase keeps its span:

- A sound keeps how it is struck — its instrument, its position and its own effects — but is struck at the volume it *ended* at, and every change of volume inside it is undone in reverse: a slide up becomes a slide down, a fitted ramp from 20 to 50 becomes one from 50 to 20, and so a swell becomes a fade. Its glides run the other way, each at the speed of the glide between the same two notes.
- A sound is let go where the original was entered from silence: with the ending that began that silence, or — after the phrase's start or a leading rest — the way the music lets its notes go (its ending on its last row, else its last ending). A reversed melody is therefore let go at its end as a melody is; music that lets nothing go (`ring: true`) is let go nowhere.
- Inside a sound, what is on a row keeps its distance from the sound's *end*: an effect one row after the strike lands one row before the reversed sound ends. Between sounds, rows are mirrored. A fitted vibrato is fitted again over the mirror image of its rows.

Reversing twice gives the music back, with three exceptions where what a reversed note did is not written in the music: a note that is never let go (a ring, a tie at the very end) after a leading rest; a note struck without a volume of its own whose volume changes inside it; and a volume that a slide drives against its limit, 0 or the maximum.

**Slower and faster.** `stretch(music, 2)` makes every row of the music two rows long, from its first row; `stretch(music, 0.5)` halves them. What happens at a moment — a note, a glide, an ending, a volume or pan set, a lone effect, a fine volume step — moves with its row, and must land on a whole row (`stretch(…, 0.5)` of a note on an odd row is an error, naming it). A glide takes as much longer: its speed is divided by the factor, rounded, and never falls below 1. What goes on through rows is drawn out over its new length: a run of one effect on rows in a row (a vibrato is stated once and recalled; a roll of retriggers goes on retriggering), the change a volume slide makes (spread over the new rows), and fitted vibratos and ramps (fitted again over their new rows). Stretching by a factor and then by its inverse gives the music back (glide speeds to within their rounding), and `reverse` and `stretch` can be applied in either order to the same notes.

```
let motif = melody(lead, 0, "D5:2 F5:2 A5:4 ~G5:4v", vol: 44)
seq(motif, reverse(motif), stretch(motif, 2))    // the motif, backwards, then at half speed
```

```
let riff = melody(bass, 0, "D2:2 A2:2 D3:4", vol: 44)
seq(riff, transpose(riff, 5), riff, rest(8))   // three times, the second a fourth up
on(bass2, shift(invert(riff, 'D2'), at(5)))    // upside down, from bar 5, on another lane
```

### 8.6 Fitted music

Some music can only be placed once the rest of the song is known. A **fitted** part is placed in the build's second pass, against every cell the song places for certain — never against another fitted part, so two that land on one row of one lane clash like any other cells. So the order the program is written in still does not matter.

| Builtin | Places |
|---|---|
| `vibrato(…)`, the `v` of a melody | `H` on the rows whose effect column the song leaves free (§8.3) |
| `vol_ramp(…)` | Fine slides on the rows whose volume column the song leaves free (§8.3) |
| `under(music, columns…)` | The music, row by row, only where the rest of the song leaves room: a row of a lane on which the song already writes anything — or, given column names, anything in those columns — is left out, the music's whole row with it. Columns: `"note"`, `"inst"`, `"vol"`, `"pan"`, `"fx"`, `"fx2"` |
| `follow(lane, from, to, f)` | The music `f(heard)` makes, where `heard` is a list with one item for each row from `from` up to `to`: what the rest of the song writes on that lane there (a record, as `cells` gives it, without `lane` and `row`), or none |

```
// a ride in eighths, except where a crash is struck
for r in 0..<14 by 2 { under(hit(cym, at(bar, r), midi(51), 40)) }
// a second voice a major third over whatever the lead plays in bars 9–16
follow(lead, at(9), at(17), fn(heard) => [hit(harmony, at(9) + i, c.note + 10, 30) for i, c in heard if c != none and type(c.note) == "number"])
```

### 8.7 Reading music

A phrase has the fields `from` and `to` (the rows it spans), `rows` (how many) and `lanes` (the lanes it plays on). What it places for certain can be read — its fitted parts are only placed with the whole song:

| Builtin | |
|---|---|
| `cells(music, lane)` | Every cell, in lane order and then row order (only that lane's, given one), as a record of the fields it has: `lane`, `row`, `note` (a pitch, or `"off"`, `"cut"`, `"fade"`), `inst`, `vol`, `vol_cmd` (true when the volume column holds a slide), `fx`/`arg`, `fx2`/`arg2`, `pos` |
| `cell(music, lane, row)` | That row's cell, as the same record (without `lane` and `row`), or none |
| `occupied(music, lane, row)` | Whether the music writes anything there |

### 8.8 Pitches and chords

| Builtin | |
|---|---|
| `note(name)`, `notes("C4 E4 G4")` | A pitch, or a list of them, from names |
| `note_name(pitch)` | The name of a pitch: `"Cp4"` |
| `degree(name)` | A degree name without a period, as its number: `degree("Bb")` is 26 in 31-TET |
| `period()` | Steps in one period (31 in 31-TET) |
| `word(pitch)` | The pitch's 4096-TET note word, as the pattern grid stores it |
| `midi(key)` | The step nearest a MIDI key (60 is C4), a tie going to the lower step — what a General MIDI drum map needs |
| `mirror(pitch, axis)` | The pitch reflected through the axis: `2 × axis − pitch` |
| `transpose(pitches, steps)`, `invert(pitches, axis)` | The same over a list (and over music, §8.5) |
| `dir(az, el)` | A position for a format-3 song, in degrees: azimuth 0 ahead, 90 right, 180 behind; elevation 90 straight up |
| `dir_arg(az, el)` | The same direction as the argument of `X` and `4` (`$eeaa`: elevation, then the azimuth halved) |
| `nearest_chord(prev, chord, lo, hi, n, need_root)` | The notes of `chord` that move least from the notes `prev` |

A **chord** is a record with `root` (a degree number) and `ivs` (its intervals in steps), and optionally a `name` for error messages: `{ root: degree("D"), ivs: [0, 10, 18, 25] }` is D 4:5:6:7 in 31-TET. `nearest_chord` returns `n` pitches (as many as `prev` has, unless given), ascending, every one within `lo`…`hi` and of the chord's pitch classes, covering as many of its classes as `n` allows — the root among them when `need_root` — and moving the least in total from `prev` note by note (what harmony textbooks call smooth voice leading). Ties go to the lower spelling. It is an error when no spelling fits. A chain of chords, each voiced from the one before, is a `scan`:

```
let voicings = scan(CHORDS, notes("C4 E4 G4"), fn(prev, ch) => nearest_chord(prev, ch, 'G3', 'G4'))
```

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
| `with(xs, i, v)` | The list with item `i` replaced by `v` (or the record with field `i` set) |
| `slice(xs, a, b)`, `reverse(xs)`, `rotate(xs, n)`, `sort(xs, key)`, `unique(xs)`, `flatten(xs)`, `zip(a, b)`, `copy(x)` | New lists |
| `map(xs, f)`, `filter(xs, f)`, `any(xs, f)`, `all(xs, f)`, `sum(xs)` | |
| `reduce(xs, f, initial)` | `f(f(f(initial, x0), x1), x2)…`: the last value |
| `scan(xs, initial, f)` | The same, keeping every value on the way: `[f(initial, x0), f(that, x1), …]` |
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
| `type(x)` | `"number"`, `"string"`, `"bool"`, `"none"`, `"list"`, `"record"`, `"range"`, `"function"`, `"phrase"`, `"lane"`, `"instrument"` |
| `print(…)` | A line in the build log |
| `error(message)`, `assert(condition, message)` | Stop the build with a message |

## 10. Randomness

A random number is not drawn from a stream: it is a function of the song's `seed` (1 unless given) and of **keys** the program gives — whole numbers and strings that say what the choice is for. `random("swing", bar)` is the same number every time it is asked, wherever it is asked, however many other choices the program makes; change the seed for another set. Since the same keys give the same number, give each kind of choice a name of its own: `chance(0.4, "extra kick", bar)` and `choose(FILLS, "fill", bar)` are independent; `chance(0.4, bar)` and `choose(FILLS, bar)` are not.

`random(keys…)` **MUST** be computed exactly as follows, so that every implementation builds the same song:

```
mix(t):
  t ← (t + 0x6D2B79F5) mod 2^32
  t ← imul(t xor (t >>> 15), t or 1)
  t ← t xor (t + imul(t xor (t >>> 7), t or 61))
  return (t xor (t >>> 14)) >>> 0

h ← seed (as an unsigned 32-bit integer)
for each key k:
  a whole number (−2^31 … 2^32 − 1):  h ← mix(h xor 0x4E554D00);  h ← mix(h xor (k mod 2^32))
  a string, as UTF-8 bytes b:         h ← mix(h xor 0x53545200);  h ← mix(h xor len(b))
                                      then for each 4 bytes of b (the last zero-padded),
                                      as a little-endian word w:  h ← mix(h xor w)
return mix(h) ÷ 2^32
```

(`imul` is the low 32 bits of the product, `>>>` an unsigned shift.) Test vectors: with seed 1, `random(0)` is 0.6445763253141195, `random("walk", 1)` 0.8974380060099065 and `random("héllo, 世界")` 0.9516397698316723; with seed 19, `random("walk", 1)` is 0.4422831176780164.

| Builtin | |
|---|---|
| `random(keys…)` | A number in [0, 1) |
| `random_int(lo, hi, keys…)` | `lo + floor(random(keys…) × (hi − lo + 1))` |
| `chance(p, keys…)` | `random(keys…) < p` |
| `choose(xs, keys…)` | `xs[floor(random(keys…) × len(xs))]` |
| `choose_weighted(xs, weights, keys…)` | An item, each as likely as its weight: `r ← random(keys…) × total`, then the first item whose weight takes `r` below 0 |
| `shuffle(xs, keys…)` | A shuffled copy: for `i` from the last index down to 1, item `i` swaps with item `floor(random(keys…, i) × (i + 1))` |

Each needs at least one key.

`noise(a, b)` is another fixed hash of two whole numbers into [−1, 1), with no seed: the same every time it is asked. It is what lane jitter uses (§11):

```
t ← (imul(a + 1, 0x9E3779B1) xor imul(b + 7, 0x85EBCA6B)) >>> 0
t ← imul(t xor (t >>> 15), t or 1)
t ← t xor (t + imul(t xor (t >>> 7), t or 61))
return (((t xor (t >>> 14)) >>> 0) ÷ 2^32) × 2 − 1
```

## 11. Building

A build turns the song's music into a project in these steps:

1. **Place.** Every cell the program places for certain, then each fitted part against them (§8.6). Each lane's cells are then read in row order — the order the following steps see them in.
2. **Compile.** Each lane's cells in each cue become one pattern of 64 rows (rows past the cue's length stay empty). Patterns with identical bytes are shared, and a lane with nothing in a cue leaves that cue empty. Patterns are named `"<label> <section>"`, numbered when names repeat. Every cue shorter than 64 rows carries its length, and the last cue stops the song.
3. **Volumes.** Each volume a lane sets becomes `clamp(round(v × trim + round(noise(lane index, row in its pattern) × jitter)), 1, max)` — `max` being 63 in format 2 and 255 in format 3 — except that a volume of 0 stays 0. The jitter depends on the row's place in its pattern, not in the song, so a repeated phrase still shares one pattern.
4. **Pans.** Each lane with a `pan` gets `S $8xxx` on the song's first row, in a pattern of its own when its first pattern is used anywhere else.
5. **Bank.** The soundfont presets are built into a bank by Microtone's soundfont converter, at the song's tempo (a soundfont's release times become fadeouts per tick). Instruments from packs are imported as the Instruments view imports a bank — only those the program names, with whatever their layers need — waveforms become new samples, OPL and PSG instruments new records of their own, formant instruments records of their own over a new cycle of their waveform (identical cycles shared) or naming their chip, and metainstruments new records over the instruments they are made of. This is where each instrument gets its slot (§7.3).
6. **Instruments.** `keep_layers`, `nna` and `fadeout` are applied.
7. **Cleanup.** Every zone of every instrument that no note in the song can reach is removed with its samples, as Housekeeping does — and, when `keep_layers` left some layers behind, every instrument nothing plays.
8. **Adjustments.** `min_fadeout`, then `layer_gain`, then the mixing chains (§7.7), each a block of the project's that its instruments name.
9. **Re-tuning** (when the song asks for it). Soundfont samples are tuned for twelve-tone music, a few cents either way — nothing in a piano, a fifth of a step in 31-TET. For each combination of zones the song's notes trigger, a held note is rendered, its pitch measured, and those zones' detune moved by the error; three passes, so the last measures the result. Layers a note sounds together move together, so a deliberately detuned pair keeps its spread.
10. **Source.** The program itself is saved in the project, in a `PMtf` section (TAUD_FILE_FORMAT.md §9.14), so that the Motif view can show it, and build it again.

The project is new and unsaved when the build finishes; save it like any other.

### In Microtone

The **Motif** tab (Shift+F7) holds a program and builds it. When the open project was built by Motif, the tab shows its program; otherwise it holds a draft of your own, kept in the browser. **Build** (Ctrl+Enter) runs the program away from the page, so a long one never freezes the app, and **Cancel** stops it. An error stops the build and is shown with its line and column — click the position to go there — and, inside a function, the calls that led to it. Opening a `.tml` file anywhere a project can be opened puts it in the tab and builds it. The editor colours the program as it is typed — keywords, declarations, numbers, strings, pitches, comments, calls, fields, and each name by what it refers to: a parameter, a lane, an instrument or a chain, or a local variable (underlined) — in the Syntello scheme on the light themes and Dimtello (a grey page) on the dark ones, and lights the line the caret is on. A song that plays a soundfont other than the bundled one, or instruments from a pack, asks for that file the first time a build needs it.

The editor reads the program as it is typed, by the scope rules of §6 (or, for a TML 1 program, of §13): the caret in a name marks the other places it is used, and right-clicking a name offers **Rename**, which changes the name wherever it refers to the same definition — named arguments and `{ name }` shorthands included — and refuses a new name that would make any name in the program refer to something else. A side panel outlines the program (**Structure**) and shows what calls a function and what it calls (**Call hierarchy**). **Preview**, on a call, runs the program and plays only what that call makes — each time it is made, as the song plays it — through the open project's instruments.

### On the command line

From `microtone-worker/` in Microtone's source:

```
node tools/motif.js song.tml [out.taud] [-v] [--check] [--no-source] [--signature TEXT]
```

`--check` runs the program and compiles the song without making the bank, and says what it would make; `--no-source` leaves the program out of the project. `--signature` sets the file's 14-character signature, which says what wrote the file and so is not the program's to choose (the app signs what it builds, and keeps the signature of a project it rebuilds); the demo songs' Makefile is what signs them "Microtone Demo". A song that needs more than a program — samples processed, an instrument pack made — is built by a Makefile too: the pack first, then the program that plays it. The bank is made by the same converter the app runs, with the local `python3`.

## 12. Limits and errors

| Limit | |
|---|---|
| Steps | 50 000 000 — each statement and each expression evaluated is a step |
| Calls | 200 deep |
| Nesting | 200 deep in the source |
| Lists and strings | 1 000 000 items or characters |
| Fitted music | 16 deep (music a `follow` makes may itself have fitted parts) |
| Source | 2 MiB |
| Lanes, instruments, mixing chains | 64, 255, 255 |

Every error names its line and column, and a mistake inside a function also lists the calls that led to it, innermost first. Errors are written to be acted on: a misspelt option suggests the one that was probably meant; a clash names the lane, the bar, the row and both values, at the line that brought the second; a bar line that falls mid-bar says how many rows in it falls; a TML 1 statement in a TML 2 program says what to write instead.

## 13. TML 1

A program that starts `tml 1` is read as the first version of the language was, and builds exactly the project it always built. TML 1 runs a program once, from the top to the bottom, like a script, and its music builtins write into the song as they run. Everything in §3–§12 holds for it, except:

- **Order.** The song is declared first, before anything that needs its tuning or its length, and the instruments before the first lane. A name can be used only below its own line — except inside a function (which runs later) and for a named function, which can be used anywhere in its block. Declarations may also stand inside blocks.
- **Changing things.** `name = value`, `xs[i] = value` and `r.f = value` change an existing name, item or field, as do `+=`, `-=`, `*=` and `/=`. Lists and records are shared, not copied, when assigned or passed: changing one changes it for every name that refers to it (`copy` makes a separate one). `push(xs, …)`, `pop(xs)`, `insert(xs, i, v)` and `remove(xs, i)` change a list in place. A `for` over a list walks a copy of it.
- **Loops.** `while c { … }` repeats while `c` is true; `break` leaves the loop and `continue` goes on to its next round.
- **Music.** The music builtins return none (`melody` returns the row after its line); a line's value is not music and is not checked. `occupied(lane, row)` says whether anything is written on that row yet, and `cell(lane, row)` what is written there so far (as the record of §8.7). `vibrato`, the `v` of a melody and `vol_ramp` step round what is written so far. There are no phrases, so none of §8.5's builtins, nor `under`, `follow`, `cells`, comprehensions, `for … if`, `fn name() =>`, `scan` or `with`.
- **Merging.** A key-off, cut or fade writes nothing on a row that already holds a note or another of them: the first written stays. A volume and a volume-column command may meet on one row, and the command is what the pattern keeps.
- **Event order.** A lane's rows are read in the order the program first wrote to each, which re-tuning (§11) groups and averages in, so moving a statement can move a detune by a unit.
- **Randomness.** `random()` and everything built on it draw from one stream, seeded by the song's `seed` and restarted by `seed(n)`, so each draw depends on every draw before it. The stream is **Mulberry32**, which an implementation **MUST** follow exactly:

```
state ← seed (as an unsigned 32-bit integer)
next():
  state ← (state + 0x6D2B79F5) mod 2^32
  t ← state
  t ← imul(t xor (t >>> 15), t or 1)
  t ← t xor (t + imul(t xor (t >>> 7), t or 61))
  return ((t xor (t >>> 14)) >>> 0) ÷ 2^32
```

| Builtin | Draws |
|---|---|
| `random()` | A number in [0, 1) |
| `random_int(lo, hi)` | `lo + floor(random() × (hi − lo + 1))` |
| `chance(p)` | `random() < p` |
| `choose(xs)` | `xs[floor(random() × len(xs))]` |
| `choose_weighted(xs, weights)` | An item, each as likely as its weight |
| `shuffle(xs)` | A shuffled copy (Fisher–Yates from the last item down) |
| `seed(n)` | Restarts the stream at `n` |

## 14. Version history

| Version | Date | |
|---|---|---|
| 2 | 2026-10-14 | Declarative: music is a value (phrases, §8.2) that can be combined and transformed — played backwards and stretched among the rest — names can be used anywhere in their block, nothing changes once made, fitted music (§8.6), keyed randomness (§10), comprehensions, `for … if` and `fn name() =>` |
| 1 | 2026-10-11 | The first version |

Additions that leave every program building as it did, in either version:

| Date | |
|---|---|
| 2026-10-22 | OPL and PSG chip instruments, `opl` and `psg` (§7.3) |
| 2026-10-28 | Formant instruments, `formant`, their syllables written in the IPA or X-SAMPA (§7.3); mixing chains, `chain` (§7.7) |
| 2026-10-29 | The transient shaper in a mixing chain, `transient_shaper_1` (§7.7) |
