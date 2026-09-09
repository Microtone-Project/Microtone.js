# Taud Conversion Notes

This document describes how music in other formats becomes Taud: what maps cleanly, what has to be approximated, and where the traps are. It covers ProTracker (`.mod`), ScreamTracker 3 (`.s3m`), FastTracker 2 (`.xm`), ImpulseTracker (`.it`), Monotone (`.mon`) and Standard MIDI plus SoundFont 2 (`.mid` + `.sf2`).

It is written for two audiences at once. If you are **using** a converter, the per-format sections tell you what to expect from your file and which options change it. If you are **writing** one, they tell you which decisions are forced by the target format and which are judgement calls that the reference converters have already made one way.

The reference converters are `mod2taud.py`, `s3m2taud.py`, `xm2taud.py`, `it2taud.py`, `mon2taud.py` and `midi2taud.py`, sharing `taud_common.py`. Microtone runs those exact files in the browser, so what this document says about them is also what the app does.

Companion documents: the **Taud File Format Specification** defines the structures every converter writes; the **Taud Engine Specification** defines how they sound; the **Note Effects** reference carries the per-command conversion tables for ProTracker, ScreamTracker 3, FastTracker 2 and ImpulseTracker sources.

The key words **MUST**, **SHOULD**, **MAY** and their negations are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold.

## 1. What every conversion faces

### 1.1 The target's hard limits

| Resource | Limit | What happens when you exceed it |
|---|---|---|
| Sample pool | 8 MiB total | Every sample is resampled down globally ([§1.2](#1-2-samples)) |
| One sample | 65 535 bytes | That sample alone is resampled further |
| Directly addressable instruments | 255 (`$01`…`$FF`) | Conversion fails, or instruments are dropped |
| Auxiliary instruments | 768 (`$100`…`$3FF`) | Reachable only as Metainstrument entries (layers, or a rack's operators) |
| Channels | 32, or 64 with `xHDR` | Excess channels are dropped |
| Pattern rows | 64 | Longer patterns are split ([§1.4](#1-4-patterns-are-single-channel)) |
| Patterns | 32 767 | Practically bounded by `patterns × channels` |
| Cues | 8192, or 4096 in 64-channel mode | — |
| Ixmp patches per instrument | Unbounded, but rectangles **MUST NOT** overlap | — |

The pattern budget is the one that bites first on wide modules, because a Taud pattern holds one channel: a 20-channel module with 64 source patterns needs 1280 Taud patterns before deduplication. The reference converters treat `patterns × channels > 4095` as a hard error for the ≤ 20-channel formats.

### 1.2 Samples

Taud samples are **unsigned 8-bit**, so every source needs depth conversion:

- 16-bit signed → take the high byte and add 128.
- 8-bit signed → XOR with `$80`.
- 8-bit unsigned → pass through.

Stereo sources are stored **split**, not interleaved: the whole left channel followed by the whole right, which matches the on-disk layout IT, S3M and XM already use. A converter that keeps stereo emits two pool spans joined by an Ixmp `s` patch; one that does not downmixes to mono.

**Pool overflow** is handled in two passes, and the order matters:

1. If the sum of all samples exceeds 8 MiB, **every** sample is resampled down by the same ratio, and each instrument's sampling-rate field is adjusted by the same ratio so pitch is preserved. This costs bandwidth song-wide, which is why options that shrink the pool are worth taking before the overflow does it for you.
2. Any individual sample still over the 65 535-byte cap is then resampled further on its own.

Both passes invalidate sample-offset effect arguments (`O`), so those **MUST** be rescaled by the same ratio — per instrument slot when the second pass resampled only some samples. A converter that resamples but forgets the offsets will start long samples in the wrong place, which usually sounds like a drum loop losing its downbeat.

### 1.3 Pitch

Every source pitch becomes a 4096-TET note word anchored at C4 = `$5000`:

| Source | Conversion |
|---|---|
| ProTracker period | `round($5000 + 4096 × log2(428 ÷ period))` |
| Semitone index *n* relative to C4 | `round($5000 + n × 4096 ÷ 12)` |
| Frequency *f* Hz | `round($5000 + 4096 × log2(f ÷ 261.6255653))` |

Per-sample tuning offsets — XM's `relative note` and `finetune`, IT's C5 speed, SoundFont's `originalPitch` and `pitchCorrection` — are baked into the instrument's **sampling rate at C4** field, or into its signed **sample detune** field, rather than being pushed into every note. That keeps the pattern readable and lets a retune operate on musical pitches.

One semitone is ≈ 341.33 units and one cent is ≈ 3.41 units, so slide arguments generally need scaling; each format's section gives its factor.

### 1.4 Patterns are single-channel

This is the structural difference that shapes every converter. A source pattern of *R* rows × *C* channels becomes *C* Taud patterns of *R* rows, and the cue that plays them names all *C* at once.

Consequences:

- **Row counts other than 64** need the cue's LEN instruction (`rows − 1` in the low six bits). A pattern longer than 64 rows is split into ⌊rows ÷ 64⌋ full cues plus a remainder cue carrying LEN.
- **Splitting renumbers the order list**, so every `B` (position jump) and `C` (pattern break) target **MUST** be remapped to the new cue indices.
- **A pattern loop (`S $Bx`) that straddles a split boundary cannot work**, because the loop is per-cue. Converters warn rather than silently mangling it.
- **Deduplication pays for itself.** Identical 512-byte patterns collapse to one copy with a remap table; on a typical module most single-channel patterns are empty and fold into one.

### 1.5 The cue sheet

A converted song's cue sheet needs three things right:

- **HALT goes on the last active cue**, not in an empty cue appended after it. Appending leaves a silent 64-row gap before playback stops.
- **A partial final bar uses HALT AT** *x* rather than plain HALT, so the song ends at its own length.
- **Trailing empty cues are trimmed** — a cue is empty only when every channel word is the no-pattern sentinel *and* both instruction words are NOP.

Looping is a cue **JMP** back to the loop-start cue, replacing that cue's HALT. When the loop start is mid-cue, an in-pattern `B` (plus `C` for the row) does the job instead.

### 1.6 Effect memory

Most trackers back their effects with per-effect or shared memory: re-issuing a command with a `$00` argument recalls the last non-zero one. Taud has memory too, but **its cohorts are narrower than ST3's or IT's**, so a naive pass-through changes which value gets recalled.

The reference converters therefore **resolve recalls eagerly**: they walk the patterns in order-list order, per channel, tracking the source's own memory model, and substitute the concrete value before encoding. The known limitation is honest and worth stating: a pattern reached from several order entries is rewritten on its first visit, so a later visit may diverge from the original if the memory state differed. In practice this is inaudible on real modules, but it is a real difference and a converter **SHOULD** document it rather than pretend otherwise.

### 1.7 Volume and pan columns

Taud's volume and pan columns each carry a 6-bit value plus a selector, and the FINE selector with value 0 is the canonical **no-op** (byte `$C0`). Two conventions follow:

- On a row that triggers a note but carries no explicit source volume, emit a **SET** with the instrument's default volume. Otherwise the channel's prior volume persists into the fresh note, which is almost never what the source meant.
- On every other row, emit the FINE-0 no-op so the column does not disturb running state.

A source volume of 64 maps to **63**, not to a rescaled value. ST3, XM and IT all display a 0…64 volume and all clamp it to six bits in the player, so 64 and 63 sound the same at the source; scaling the whole range by 63/64 to make 64 "fit" would quietly pull every other volume in the song down. Clamp, do not scale.

Effects that only set channel volume or panning (`M`, `N`, `X`, `P` in ST3 terms) **SHOULD** be folded into these columns, which frees the effect slot for something that genuinely needs it. Each cell has exactly one effect slot, and on dense material that slot is the scarcest resource in the whole conversion.

### 1.8 Subsongs

Modules do not carry a subsong table; subsongs emerge from the order list's flow graph. The shared detector takes the lowest unvisited non-terminator order as the next subsong's entry point, walks forward reachability through fall-through and `Bxx` targets, marks everything reached as visited, and repeats.

The subtlety is fall-through: it is treated as **dead** when the pattern at that order carries a `Bxx` on its absolute last row, which is every tracker's idiom for "the song ends here, loop back". Without that rule, subsongs separated only by `Bxx` terminators — with no explicit `$FF` marker — merge into one. In practice this finds 4 subsongs in `WHEN.s3m` (which does use `$FF` separators) and 8 in `Insaniq2.it` (which does not).

Each detected subsong becomes one entry in the Taud song table.

### 1.9 Project Data

Everything that is naming or presentation rides in Project Data: instrument names (`INam`), sample names (`SNam`), pattern names (`pNam`), the project name and message (`PNam`, `PMsg`), and per-song metadata including the display notation and beat divisions (`sMet`).

**`Ixmp` also lives there**, and it is not cosmetic. Omitting Project Data — every converter has a `--no-project-data` flag — collapses each instrument to its single canonical sample, silently discarding keyboard maps, velocity layers, per-sample envelopes and stereo pairs. Use the flag for size experiments, not for output you intend to listen to.

### 1.10 Compression

Each compressed payload picks its own codec: the converters compress with gzip and zstd and keep whichever came out smaller, and every Taud reader sniffs the magic. Under Pyodide the `zstandard` package is absent, so the browser falls back to gzip — which every reader accepts, at a modest size cost.

## 2. ProTracker — `.mod`

ProTracker is the simplest source and the one whose *emulation* details matter most, because so much of its sound is the Amiga hardware rather than the notes.

### 2.1 Global setup

The converter sets two global behaviour flags: **Amiga period tone mode** and **Amiga 500 interpolation**. Together those give period-space pitch slides, zero-order-hold sampling and the post-mix 4.4 kHz low-pass — the reason a converted MOD sounds like a MOD rather than like a clean 32 kHz sampler.

`E00` / `E01` (filter on/off) map to `S $00` / `S $01`, which the engine honours only in the Amiga interpolation modes.

### 2.2 Pitch and slides

Periods convert against ProTracker's period 428 for C4. Because the song runs in Amiga period mode, coarse `1xx` and `2xx` slide arguments pass through **unscaled** — the engine consumes them in period space directly. Fine slides (`E1x`, `E2x`) do the same.

Tone portamento (`3xx`) is the exception: Taud treats `G` as linear even in Amiga mode, so its argument is scaled to 4096-TET units by `round(arg × 64 ÷ 3)`.

Arpeggio nibbles are semitone offsets and go through the shared table: one Taud argument byte is 256 units ≈ 0.75 semitones, so `byte = round(semitones × 4 ÷ 3)`.

### 2.3 Effects

Full ProTracker dispatch per the Note Effects conversion table, with these folds:

| Source | Becomes |
|---|---|
| `Cxx` (set volume) | Volume column SET |
| `Axy` (volume slide) | Effect-column `D` — **not** the volume column |
| `EAx` / `EBx` (fine volume slide) | Volume column |
| `8xx`, `E8x` (panning) | Pan column |
| `5xy` (porta + volume slide) | `L` verbatim |
| `6xy` (vibrato + volume slide) | `K` verbatim |
| `Dxx` (pattern break) | `C`, BCD-decoded |
| `E0x` (LED filter) | `S $0x` |

`Axy` routes through the effect column rather than the volume column for a specific reason: when a row carries both `Cxx` and `Axy`, the volume column can encode only one of them, and the slide is the half that gets lost — five ticks of slide per row, which is audible. Keeping the slide in the effect slot preserves both.

`5xy` and `6xy` map to `L` and `K` verbatim rather than being split into a portamento plus a volume-column slide, for the same reason: the split loses the slide on any row that also needs a volume SET.

Sample finetune is pre-baked into each instrument's sampling rate, so notes stay clean.

### 2.4 `E $Fx` — one slot, two effects

`E $Fx` is the one ProTracker command whose *meaning* depends on which ProTracker wrote the file, and nothing in the file says which.

- **ProTracker 1.0C — Funk Repeat.** Adds one whole loop length to the channel's repeat pointer each step, writes it into the audio hardware's loop register, and snaps back to the real loop start when the next block would not fit inside the sample. The loop hops through the body of the sample; the sample data is never touched. Taud's `Z $F0yy`.
- **ProTracker 1.1B onwards — Invert Loop.** Advances a cursor one byte through the loop each step and one's-complements the sample byte it lands on, in place. The loop degrades into a buzz; the sample data is permanently modified. Taud's `S $F0yy`.

The two share ProTracker's handler, its speed nibble, its accumulator and its speed table, and in ProTracker's sources they share every name (`mt_FunkIt`, `mt_FunkTable`, `n_funkoffset`) — 1.1B replaced one routine body and left everything around it, including the now-dead sample-length field that only Funk Repeat had read. That is why the two are so widely conflated, and why a source listing labelled "funk" is no evidence of which effect it implements.

**What a converter must do.** `mod2taud.py` emits `S $F0yy` with `yy = funk_table[x]`, and a converter **SHOULD** do the same. It is not a coin toss: the scene settled on Invert Loop within a year, every player from PT 2.x onward implements only that, and a module carrying `E $Fx` today was overwhelmingly written and checked against it. A converter **MUST NOT** try to detect the author's intent — there is no version field, no flag, and no reliable heuristic. Offer `Z $F0yy` as a **user-selected** compatibility mode for modules known to predate 1.1B, and nothing else.

**Which release changed.** 1.0C has Funk Repeat and 1.1B has Invert Loop, both established from the playroutine sources. 1.1A is not settled by surviving source — the copy that reaches us is damaged exactly where the routine sat — but its help file and effect list are 1.0C's, still documenting Funk Repeat ("add replen to repeat"), its own changelog lists only the vibrato-depth change against 1.0C, and 1.1B's lists that change *plus* "Funk Repeat changed to Invert Loop". So the change is 1.1B's, and a module of 1.1A vintage or earlier is the case where `Z $F0yy` is the honest import.

**If you convert to Funk Repeat, check the loop first.** The effect needs room: a loop occupying the tail of its sample cannot hop anywhere and is silent, and a loop as long as its sample is silent for the same reason. That is faithful behaviour, not a conversion fault, but it means `Z $F0yy` on a module whose samples all loop to the end will do nothing at all — in which case the module was written for Invert Loop anyway, which is the useful signal in the other direction.

## 3. ScreamTracker 3 — `.s3m`

### 3.1 Instrument indexing

S3M instrument numbers are 1-based on disk and in cells, and Taud's cell instrument byte preserves that: 0 means "no instrument change", 1…255 select a slot. The converter passes the raw byte through with no subtract-1, writes the instrument bin at `index × 64`, and leaves slot 0 empty.

AdLib/OPL instruments are skipped — there is no FM synthesis in Taud.

### 3.2 Shared-memory recall

ST3 backs effects `D`, `E`, `F`, `I`, `J`, `K`, `L`, `Q`, `R` and `S` with a **single per-channel memory slot**, so a `$00` argument on any of them recalls whatever any of them last set. Taud's cohorts are narrower, so the converter resolves every such recall eagerly ([§1.6](#1-6-effect-memory)).

### 3.3 Numeric quirks

- **`Cxx` is BCD on disk.** `$10` means decimal row 10, not hex row 16. Decode as `(byte >> 4) × 10 + (byte & $F)`; anything decoding to 64 or above clamps to row 0. (IT's `Cxx` is plain binary — the two formats differ here and mixing them up shifts every pattern break.)
- **The coarse pitch-slide unit is 1/16 semitone**, ≈ 21.33 Taud units, so `E`, `F` and `G` coarse arguments are multiplied by `$0015`. Fine forms are packed into Taud's `$F0xx` fine form after the same per-step scale.
- **Global volume is 0…$40**, scaled to Taud's 0…$FF by ×4 with a clamp.
- **Tempo** is a raw decimal BPM; Taud's byte is biased −25. The converter also scans row 0 of the order list's first pattern for `A` and `T` and prefers those over the header defaults, because that is where trackers actually put the intended tempo.

### 3.4 Default panning

Row 0 of every pattern emits a pan-column SET derived from the S3M channel-setting byte — channels 0…7 left (`$10`), 8…15 right (`$2F`), otherwise centre (`$1F`). Every other row emits the FINE-0 no-op unless an `X`, `P` or `S $8x` overrides it.

## 4. FastTracker 2 — `.xm`

### 4.1 Multi-sample instruments

XM instruments carry a 96-key sample map. `xm2taud` materialises **one Taud instrument slot per (XM instrument, sample) pair** and picks the slot from the triggering note's keymap entry.

That is a different choice from `it2taud`, which uses Ixmp patches to keep one Taud instrument per source instrument. XM could be retrofitted the same way to conserve slots; it has not been, because no real XM file has yet hit the 255-slot cap. If you are converting a bank-heavy XM that does, this is the knob to turn.

### 4.2 Pattern length

- ≤ 64 rows → one cue, with the LEN instruction when the count is under 64 and no instruction when it is exactly 64.
- > 64 rows → ⌊rows ÷ 64⌋ full cues plus, when there is a remainder, a final cue carrying LEN for the leftover rows.

### 4.3 Tuning

XM combines a per-sample `relative note` (signed semitones) with a `finetune` in 1/128-semitone units. Both are baked into the instrument's sampling rate:

```
semitones = relative_note + finetune ÷ 128
c2spd     = max(1, round(8363 × 2 ^ (semitones ÷ 12)))
```

so an XM "C-4" row sounds correct when the Taud note is also C4.

### 4.4 Envelopes and fadeout

XM volume (0…64) and panning (0…64, with 32 as centre) envelopes convert to Taud's 0…63 and 0…255 ranges. XM's single-point sustain becomes a SUSTAIN word with equal start and end; XM's envelope loop becomes the LOOP word. The two are independent in XM and stay independent in Taud.

**Fadeout needs rescaling and this is a common mistake.** FT2's per-tick decrement is `stored ÷ 32768` of unit volume; Taud's is `stored ÷ 1024`. Divide by 32, rounding to nearest:

```
taud_fadeout = min((xm_fadeout + 16) ÷ 32, $0FFF)
```

XM values 1…15 round to Taud 0 — those originals ran over eleven minutes at 50 Hz and were effectively "no fade" anyway. XM 32 becomes Taud 1 (≈ 20 s). MilkyTracker writes 32767 to encode its "cut" slider, which becomes Taud 1024, a one-tick cut.

Auto-vibrato: XM's rate becomes Taud's "speed" and both it and the depth take the same ×4 into the 0…255 bytes that IT's `Vis` and `Vid` take — an XM depth of 15 and an IT `Vid` of 15 sound the same ±25 cents, so the two formats share one scale. Sweep and waveform pass through, and the rate byte (188) stays 0: that field is IT's ramp acceleration, XM has no equivalent, and a value there would turn FT2's "sweep 0 = full depth at once" into a ramp thousands of ticks long.

### 4.5 NNA

XM has no New Note Action — every new note unconditionally retriggers the channel. Converted instruments therefore get NNA = Note Cut, which reproduces that. Do not "improve" this to Note Fade: it changes the arrangement of any XM that relies on retrigger cutting a ringing note.

### 4.6 Effects

Full XM dispatch per the Note Effects conversion table. Volume-column commands fold into the Taud volume column when they can, or occupy the main effect slot when it is free, and are dropped otherwise — the same policy `it2taud` uses. `E5x` (set finetune) becomes `S $5x`. Position jump and pattern break are remapped to Taud cue indices after any pattern splitting.

`Kxx` (delayed key-off) carries no note-column entry of its own in XM — it acts on whatever is already sounding — so it cannot become `S $Dx00` on a `NOTE_KEYOFF` sentinel the way a note-column key-off can; that path fires the key-off at `$x` and leaves nothing else to defer. Instead it becomes `S $D00xx` (`x`=0, `n`=0 note off, `y`=`xx` clamped to the 4-bit range, i.e. `min(xx, $F)`, never a truncating mask — `K10` must land on `y=$F`, not silently become a no-op at `y=0`) and the row's own note column is left empty, letting the engine's follow-up-action mechanism apply the note-off to the sounding voice at the right tick. `K00` (arg 0) has no follow-up window to defer into — `S $D`'s action never arms when `$y` is zero — so it still forces an immediate `NOTE_KEYOFF` instead. One gap survives the fix: the FT2-only quirk where a key-off on a vol-env-off instrument hard-mutes the volume (see the `keyoff_zero_rows` gating below) cannot be replayed on the deferred tick without re-losing the delay, so it is skipped for a delayed `Kxx` — only the real note-off fires.

## 5. ImpulseTracker — `.it`

IT is the richest source and maps onto Taud most directly, because most of Taud's instrument model exists to carry IT semantics.

### 5.1 Channels

The converter takes the non-muted, in-use channels: 32 or fewer stay in the default layout, 33…64 switch the file to **64-channel mode** (the `xHDR` flag), and only a song exceeding 64 active channels is capped. A channel is "muted" when its pan byte has bit 7 set or reads `$C0`, and "in use" when any cell on it is non-empty.

### 5.2 Instruments and Ixmp

Each IT instrument becomes **one** Taud instrument, whose base record carries the C5 canonical sample, plus an Ixmp patch list covering every keyboard cell that maps to a different sample. Patch rectangles are contiguous runs of keyboard cells pointing at the same sample, which guarantees the no-overlap rule because the keyboard map is itself a partition.

Per-patch fields mirror what the base record would have stored for that sample — loop points and mode, default volume and pan, auto-vibrato — so a patched note behaves exactly as a base-record note on the same sample would.

Volume, panning and pitch-or-filter envelopes convert natively, with up to 25 nodes, both sustain and loop regions, and the `P` presence bit set whenever nodes are emitted. Auto-vibrato, fadeout, pitch-pan centre and separation, default pan, volume and pan swing, and initial filter cutoff and resonance all forward to their instrument fields. AdLib instruments are skipped.

IT2.14/IT2.15 **compressed samples** are decoded during conversion. The compression flag is per sample (bit 2 of the sample's `cvt` byte), *not* global via the file's `cwt` — reading it globally mis-decodes mixed files.

**Stereo samples are kept by default**: the two channels become two pool spans joined by an Ixmp `s` patch. Because a base record cannot express a stereo sample, a stereo canonical sample is treated as non-canonical and gets patches over its own keyboard runs. Downmixing to mono is available as an option.

### 5.3 Sample-mode files

An IT file that does not set the "use instruments" flag has no instrument records at all — pattern cells name samples directly. Such a file gets one Taud instrument per sample, and every field that only an IT instrument could have fills in with its neutral value: no envelopes, no fadeout, no pitch-pan, filter off.

The fields an IT **sample** carries in its own right still convert: its default volume, its default pan (`IMPS+$2F`, when the sample's own use-panning bit is set) and its auto-vibrato.

**`Vir` = 0 means the sample has no auto-vibrato**, however deep its `Vid`. IT's rate field is the only thing that lifts the depth accumulator off zero, so a sample that names a speed and a depth but leaves the rate at zero is silent in IT and in OpenMPT. Taud reads a record with both ramp fields at zero as full depth from the first tick — the FT2 convention, and the one the instrument editor needs — so the conversion carries that silence as a depth of 0 rather than as the rate it came from.

**New Note Action is the one field where "neutral" is not zero.** Sample mode has no NNA: a new note replaces whatever the channel was playing, exactly as in `.mod`, `.s3m` and `.xm`. Converted samples therefore get NNA = Note Cut, so no ghost is spawned. Note Off — the value the field's zero encodes — would keep a ghost running per trigger, and with no volume envelope and a fadeout of zero it would never stop ringing.

### 5.4 Pattern splitting

IT patterns may exceed 64 rows, and are split into ⌈rows ÷ 64⌉ consecutive Taud patterns. `B` and `C` targets are remapped onto the new cue indices; an `S $Bx` pattern loop crossing a chunk boundary is warned about, since a Taud loop cannot span cues.

### 5.5 Note delays past the row

IT triggers a note delay *during* the current row, so a delay of `x` ticks with `x ≥ speed` never lands — the note is silently lost. The converter relocates such a note to the next row with `delay = x − speed`, but only when that next row on the same channel is empty. This recovers notes that IT itself would have dropped, which is a deliberate deviation in favour of the music.

### 5.6 Portamento eats the instrument byte

IT does not reset an instrument's envelopes when a row carries a note, an instrument number **and** a tone portamento. With Compatible Gxx off — the ordinary case — such a row never reaches the envelope reset at all, so the envelopes carry on from the previous note whether or not the instrument's Carry flag is set. Schism's own comment on the surrounding conditions is "experimentally determined… seems like it's just a total mess"; OpenMPT carries the quirk as `kITPortamentoInstrument` / `kITEnvelopeReset` and was still correcting corners of it in 1.32.11.

The Taud engine deliberately does not reproduce it: an instrument byte on a portamento row re-attacks the four playheads (TAUD_ENGINE_SPEC §5.2), which is FastTracker's rule and the one a tracker musician can predict. Envelope carry is spelled out instead, in the LOOP word's `c` bit, where it is a property of the instrument rather than an accident of the row.

So the converter resolves it at conversion time: **a note tied by `G` or `L` that names the instrument the channel is already holding is written without the instrument byte**, which is what an IT author's ear expects and how the passage would be written by hand. The byte is dropped only when it names the *same* instrument — that is precisely the case where IT reloads nothing, so nothing else goes with it. A portamento row naming a *different* instrument keeps its byte: there IT does swap the sample and clear the key-off, and the Taud re-attack is much the closer of the two readings.

The volume-column `Gx` counts as a portamento here whenever it will actually reach the pattern — when the main column is empty, or holds a non-zero `D` that folds into `L`. Where the vol-column porta is dropped for want of a slot the row is not tied in the output, and it keeps its instrument byte.

### 5.7 Effects

A–Z dispatch per the Note Effects reference, with the IT-specific readings:

| Command | Reading |
|---|---|
| `Cxx` | **Binary**, not BCD as in ST3 |
| `V` | IT 0…128, scaled ×2 to Taud 0…255 |
| `X` | Full 8-bit IT panning |
| `Y` | Panbrello, nibble-repeated to 8 bits |
| `Z` | MIDI macro — **dropped** |
| `S6x` | Fine pattern delay, forwarded directly |
| `SAx` | High sample offset — **dropped** |
| `S7x` | NNA, past-note and envelope toggles; the IT sub-codes match Taud one-to-one |

Memory cohorts are resolved eagerly: `D`, `K` and `L` share one; `E` and `F` optionally link with `G` per the header's flag bit 5. Volume-column pitch-slide, tone-portamento and vibrato sub-commands move to the main effect slot when it is free and are dropped otherwise.

Global and mixing volume are IT's 0…128, scaled by 255/128 and rounded.

## 6. Monotone — `.mon`

Monotone is Calvin "Trixter" French's tracker for the PC speaker, Tandy and TI-99 SN76489. It has no user-defined instruments — the only instrument is the beeper — 1…12 voices, 64 rows per pattern, ProTracker-flavoured 2-byte cells, and eight effects: `0`, `1`, `2`, `3`, `4`, `B`, `D`, `F`.

### 6.1 The instrument

The converter synthesises a single instrument: a 32-byte, 50 %-duty square wave at offset 0 of the pool, looping forward, with a sampling rate of 8372 Hz so C4 sounds at 261.6 Hz. Its instrument global volume is set to `$A0` for headroom (a square wave is loud), its default note volume to full, its filter off, and its NNA to Note Cut. Every Monotone voice plays this one instrument.

### 6.2 Pitch and slides

Monotone note value 1 is A0, so C4 sits at value 40 and `note = $5000 + round((value − 40) × 4096 ÷ 12)`. Value `$7F` is a note cut.

The interesting decision is the slides. Monotone's `1xx`, `2xx` and `3xx` are **Hz per tick** — its player literally adds the argument to a frequency. Rather than rescale them into 4096-TET units and accumulate drift, the converter emits them verbatim and turns on Taud's **linear-frequency tone mode**, so the engine performs exactly the same arithmetic the original player did. Interpolation is set to none, matching a square-wave source.

### 6.3 Effects

| Monotone | Taud |
|---|---|
| `0xy` arpeggio (two 3-bit nibbles) | `J`, through the semitone table |
| `1xx` / `2xx` slide up/down | `F` / `E` in Hz per tick |
| `3xx` tone portamento | `G` in Hz per tick |
| `4xy` vibrato (3-bit speed and depth) | `H`, each nibble scaled ×36 into a byte |
| `Bxx` position jump | `B` |
| `Dxx` pattern break | `C` |
| `Fxx` set speed | `A` (an argument of 0 is invalid in Monotone and becomes a no-op) |

## 7. MIDI and SoundFont 2 — `.mid` + `.sf2`

This is the least mechanical conversion: MIDI has no patterns, no rows and no channels-as-voices, and a SoundFont is a sampler bank rather than a tracker instrument list. Almost everything here is a judgement call.

### 7.1 The rhythmic grid

MIDI time is continuous; Taud time is rows and ticks. The converter chooses **rows per beat** and **ticks per row** together, from the tempo map, the time signatures and an analysis of which onset subdivisions the song actually uses. The chosen `rpb × speed` fine-ticks per beat must represent the finest subdivision in use, keep every tempo inside the 25…535 BPM register, and stay near the proven 24-fine-ticks-per-beat grid — so plain 4/4 at 120 BPM still comes out as the familiar speed 6, 4 rows per beat.

Pinning either axis on the command line auto-fits the other; pinning both overrides the analysis entirely.

As a final step, a bend- or polyphony-heavy song with fewer than 8 rows per beat has its `rpb` doubled and its `speed` halved (leaving tempo and `F` unchanged), up to 8. The extra rows give key-offs, choke events, portamento and channel-volume effects distinct rows to land on, so fewer are lost to same-row collisions — each cell has only one effect slot.

Sub-row timing is then carried by `S $Dx` note delays.

**The declared tempo may not describe the events at all.** Some MIDIs are internally consistent but written on a grid that is not the file's quarter note: the beat is 1.2 or 1.35 quarters long, so bar lines fall mid-phrase, rows-per-beat means nothing, and every analysis above measures against the wrong unit. It happens whenever the tick clock is really a fixed rate — a tempo of 60 at 240 PPQ is 240 ticks per *second*, not a musical tempo — and whenever a part was typed in against the wrong project tempo. The repair is a **rescale, not a rewrite**: multiply every event tick *and* every tempo by one factor `r`. Wall-clock timing is then preserved exactly, since each tick is `r` times shorter and there are `r` times as many of them; no note moves relative to any other; and choosing `r` so that the music's own beat becomes one quarter note leaves the file declaring the tempo it actually plays at. A converter **MUST NOT** snap anything as part of this — quantisation is the separate, later step below, and the two compose.

`r` has two possible sources and a converter needs both. The operator's own figure, `r = wanted ÷ declared`, is the only thing that can help a file whose grid is *fine* and whose tempo number alone is wrong, because that fault leaves no trace whatsoever in the event positions. Otherwise the beat is inferred from the onsets: cluster near-simultaneous note-ons so that a spread chord counts once and carries its size as accent weight, take candidate periods from a harmonic comb over the inter-onset-interval histogram, then sharpen each candidate into an exact period by maximising the onset train's **phase coherence** — the length of the weighted mean unit vector at that period, 1 for a perfect grid and 0 for none. Coherence is the right statistic because it needs neither a tolerance nor a phase guess: a least-squares fit over a long song locks onto a period a hundredth of a percent out and then reports the accumulated drift as if the music itself were ragged.

What no timing analysis can settle is the **metrical level**. A stream of eighths at 162 BPM and one of sixteenths at 81 are the same set of onsets. The beat is some whole number of grid units, and choosing which number is a judgement: weigh how ordinary the resulting tempo is, how far it moves the file from what it declares, and whether onset weight really does cluster on that level. A converter **SHOULD** report the reading it chose together with the alternatives, and **MUST** offer the operator's override. Two refusals are required as well. When the ratio comes out at 1 the file is already on its own grid and **MUST** be left exactly as it was — a realignment offered by default is worthless if it perturbs healthy files. When coherence is low the onsets are not a mis-tempoed grid but no grid at all, which is what a rubato performance looks like, and a converter **MUST NOT** invent a beat for it.

**Nothing is quantised unless the operator asks.** A MIDI that was *played* rather than stepped in carries its performance in exactly those sub-row delays, and a converter that tidied them away by default would be discarding the take. An opt-in quantiser snaps notes onto a beat subdivision — the one the onsets already use, the row grid, or a named fraction — and its strength dial says how far each end moves, so a light setting tightens sloppy playing while leaving a deliberate push or drag audible.

**Both ends are snapped, not just the onset.** Moving the onset alone leaves every release exactly as ragged as it was played, so the sub-row delays this was meant to clear up survive on the key-offs. A quantised note therefore lasts a whole number of grid steps — with one floor: a note shorter than half a step has both ends land on the same grid point, and it **MUST** keep the shortest length the grid can hold rather than being stretched to a full step, or every drum hit and grace note in the file becomes a sixteenth.

That floor is the only thing that can leave an overlap **shorter than one step** behind, because everything else now sits on the grid and overlaps by whole steps. Within one channel and one key such an overlap is impossible in the source — nothing strikes one key twice at once — so a converter **SHOULD** resolve it: shorten the earlier note to the later one's onset, or, when both landed on the same grid point, drop it, since two strikes collapsed onto one instant are one strike. The same test **MUST NOT** be applied across different keys of one channel: a kick sounding under a hi-hat overlaps in exactly that way and is not an accident. Quantising runs after the grid has been chosen, because the picker reads the raw onsets and must see the timing the performance was aiming at rather than one this pass has already imposed. A converter offering this **SHOULD** warn that it erases swing, flams and grace notes along with the mistakes.

Tempo changes become `T $xx00`, or the extended `T $FFxx` form above 280 BPM. Channel volume and expression (CC7 × CC11) become `M $xx00` channel-volume effects, deliberately **not** volume-column writes: the volume column is the velocity axis that selects Ixmp patches, and driving it from CC7 would change which sample plays.

Cues break at every time-signature change, and each section is packed into whole-bar cues — the largest multiple of its bar length that fits in 64 rows — so a tracker's beat highlighting lines up with the music.

### 7.2 Pitch bend

Bends **MUST** be preserved as far as the format allows, and Taud's 4096-TET grid allows a lot.

- A note starting under a non-zero bend triggers **directly at the bent pitch**; MIDI can start a note already bent, and a tracker cannot, so the trigger encodes the shifted pitch exactly.
- Movement during a note becomes linear segments: one row each, carrying the exact target note plus a tone portamento (`G`) sized to arrive by the row's end.
- Jittery curves are simplified against a cents threshold (default 4 cents).
- RPN 0,0 **pitch-bend-range** messages are honoured — a converter that assumes ±2 semitones will render wide-bend songs wrong by a factor.
- Bend values are computed as floats from the full 14-bit word, so MIDIs that only drive the MSB work transparently.

### 7.3 Note-off idioms

MIDI has two: a real note-off message, and a note-on with velocity 0. **Both** become Taud key-off.

Percussion-channel key-offs are **dropped by default**, because GM percussion ignores note-off and emitting them chops one-shot drum tails. An option re-enables them for kits that genuinely sustain.

**A note too short for the grid must not disappear.** A note only a handful of MIDI ticks long lands on the very fine tick it started on, and a zero-length note has nothing to convert; dropping it is the obvious thing to do and it is wrong. The idiom this destroys is percussion: because GM drums ignore note-off, a sequencer writes each hit as the shortest note it can — one or two ticks — so a whole kit can vanish from a converted song. It is phase-dependent too, since the tick-to-fine-tick conversion rounds: the same short note survives or dies depending on which tick it starts on. A converter **MUST** therefore hold any note the source gave a duration to at least one fine tick, and **MAY** drop only a note the source itself wrote as zero-length — a note-on and a note-off on the same tick, which is an artefact rather than a performance. One fine tick is enough for both kinds of part: a drum keeps its trigger and, having no key-off, rings its sample out in full, while a melodic note's key-off rounds up to the next row along with every other sub-row note.

### 7.4 SoundFont presets to Taud instruments

Each preset's zones are partitioned into the fewest mutually **disjoint** layers (default cap 4, and about 93 % of big-bank presets fit in 4, 98 % in 5). Each layer becomes one ordinary Taud instrument with its zones as Ixmp patches, on a velocity axis of `round(velocity × 63 ÷ 127)`.

A preset needing more than one layer becomes a **Layered Metainstrument** (type 0 — the family's other kind, the type-4 FM Rack, is never produced by a conversion): the note references the meta slot and the engine fans out one voice per matching layer. This is what makes SoundFont's simultaneous layering and detune stacks actually sound; before Metainstruments existed, overlapping zones had to be dropped. Single-layer presets stay plain instruments. Layer sub-instruments are allocated in the **auxiliary bin**, so they do not consume the 255 directly-addressable slots.

By default the full zone map is kept as Ixmp patches, so imported instruments stay playable across the whole keyboard rather than only where this song happened to play them. Trimming to triggered patches is available for the smallest file — and is worth using when the untrimmed pool overflows 8 MiB, since that overflow resamples *every* sample and costs quality song-wide.

Stereo SF2 samples are mixed to mono by default; an option keeps them as genuine stereo pairs at double the pool cost.

SoundFont's **`keynum`** generator — a zone that overrides the played key, so it always sounds one pitch — has a home in the target now: a type-0 layer's **fixed-pitch** flag ([File Format §7.4](TAUD_FILE_FORMAT.md#7-4-metainstrument-records)) says exactly that, with the layer's detune field carrying the absolute note. The converter does **not** read it yet, so a `keynum` zone imports as an ordinary pitched layer and plays that part of the patch transposed by whatever key strikes it. It is worth knowing which way the error runs: too high up the keyboard, and audible mostly on the fixed clicks and thumps such zones are used for.

**Far-loop samples** get special treatment. A looped sample whose loop point sits past the 65 535-frame cap even at 32 kHz — multi-second sustain instruments in large banks — would otherwise force the whole sample to be resampled down until it fits, muffling it. By default such a sample instead gets a *synthesised* loop at 32 kHz plus a 10-second decay: the genuine sustain loop is traded for full bandwidth. An option restores the real loop and accepts the muffling.

### 7.5 The ADSR mapping

This is the part most likely to be got wrong, because SoundFont's release is not a tracker envelope stage.

The SF2 volume envelope's **delay, attack, hold and decay** become Taud volume-envelope nodes, with a sustain region held while the key is on. There is **no release leg in the envelope**. Instead, the SF2 *release segment* becomes the **Volume Fadeout**, with NNA = Note Fade: on key-off the voice holds at its sustain node and fades to silence over the release time.

Because Taud's fadeout is linear in amplitude while FluidSynth's release is linear in decibels, the release time is scaled to FluidSynth's *perceived* release length rather than copied. Per-layer Ixmp patches carry their own fadeout when their release differs from the canonical zone's.

Fadeout steps encode seconds **per song tick**, and the tick rate is proportional to BPM. A bank built for one tempo therefore has slightly wrong release times at another — which is why batch mode targets the mean of its songs' initial tempos, and why a tempo-independent override exists.

SF2 `initialAttenuation` is a per-zone static gain with no dedicated legacy field, so converters fold it into the per-patch **volume envelope's node peaks**, scaling every 0…63 node by `10^(−attenuation_cB ÷ 200)`. It multiplies with the velocity-driven note volume — it cannot live in the patch's default note volume, which an explicit volume column overrides at trigger time — so velocity layers differ in level as well as in ADSR shape. Newer files may use the dedicated initial-attenuation octet instead.

Melodic instruments get the **key lift** flag, so key-off behaves like a MIDI key release: the volume envelope jumps straight to its sustain end and the release plays at once, instead of ringing on through the remaining pre-sustain nodes like a depressed sustain pedal.

### 7.6 Polyphony

Polyphony rides on New Note Actions, which is what makes MIDI-shaped music fit a tracker at all. Every instrument, drum kits included, gets **NNA = Note Fade**: a voice column becomes reusable the moment its note releases, and the release tail moves to a background ghost that dies over its own release time.

The voice-column budget defaults to 32. A song exceeding it releases the oldest pedal-held or soonest-ending note **early** rather than cutting it. Raising the budget above 32 opts into 64-channel Taud mode, but only takes effect if the song actually allocates 33 or more voices.

SF2 **exclusiveClass** (generator 57) is honoured on the percussion channel: a new note in a class chokes any ringing note of the same class, matching FluidSynth's kill-by-exclusive-class. The choke is emitted as the fast note-fade sentinel (`$0004`, ≈ 0.3 s) at the next same-class onset. Without it, long percussion tails wash over the whole beat — an open hi-hat ringing through the closed one that should have stopped it.

### 7.7 Looping

A MIDI that carries its own loop markers is **always** made to loop at those points, regardless of any command-line loop flag. Recognised conventions, case-insensitive, first occurrence winning, in priority order:

1. Text or copyright meta-events beginning with `loops` (start) and `loope` (end).
2. CC 116 (start) and CC 117 (end).
3. CC 110 (start) and CC 111 (end).
4. CC 111 alone as a loop **start**, with the loop end at End-of-Track.

A missing loop end defaults to End-of-Track. The loop is realised as a cue **JMP** when it spans complete full-length cues from a cue boundary; otherwise as an in-pattern `B` (plus `C` for the row when the loop start is mid-cue) on the last looped row. Cues after the loop end are dropped.

Whole-song looping rounds its loop end **up to the next bar line** by default, so the seam stays on the beat and usually lands on a full cue — that is, a clean JMP. Bar rounding never applies to explicit MIDI loop markers, which loop verbatim.

### 7.8 Batch mode and split output

Pointing the converter at a **directory** compiles every MIDI in it against one SoundFont into the split format: a single shared `.tsii` holding the bank for all the songs, plus one `.tpif` per MIDI carrying just that song's patterns.

The shared bank spans the **union** of every song's instruments, so the 8 MiB pool and the 255-slot budget are shared too, and overflow degrades exactly as in single-file mode. A `.tsii` plus its `.tpif` combine to precisely the `.taud` that a single-file conversion of the same MIDI would have produced — which is the property the conversion tests pin.

## 8. AdLib and Iyagi Music Sound — `.ims` + `.bnk`

**Iyagi Music Sound** is the music format of *Iyagi*, the Korean BBS terminal of the early 1990s: an AdLib `.rol` score converted to a MIDI-shaped event stream at 240 ticks per beat, played on a YM3812 (OPL2). Two things make it unlike every other source here. The song **names** its instruments instead of storing them, so a companion `.bnk` bank is not optional — without one nothing sounds. And its instruments are not samples at all but **two-operator FM patches**, which is why this is the one conversion whose output is Metainstrument type 4.

### 8.1 The grid comes from the delta times

ROL was a step sequencer, and the converter that turned it into an event stream only rescaled the clock — so the **greatest common divisor of every delta time IS the composer's original tick**, and `240 ÷ gcd` is the rows per beat. Every GCD observed across 1128 reference songs divides 240, so the grid is exact and no event is quantised away. Header byte 50 states the same number outright in the 59 files that set it, and it agrees with the GCD in all of them; it is a cross-check, not a shortcut, because the other 1069 leave it zero.

Speed and BPM are then one equation with a free parameter — a row lasts `speed × 2.5 ÷ BPM` seconds — and the parameter is spent on making the **tick as short as the 535 BPM ceiling allows**. That is not cosmetic: the tick is the resolution of every envelope in the engine, and an OPL percussive attack of two milliseconds smeared over a 20 ms tick is a different instrument. A typical song lands near 480 BPM at speed 8, so its tick is 5 ms rather than 20. A tempo change re-solves the same equation and writes `A` and `T` on two channels of the same row.

### 8.2 An OPL patch is an FM rack

Each patch the song names is compiled into a type-4 Metainstrument ([File Format §7.6](TAUD_FILE_FORMAT.md)), whose operators are ordinary instruments holding one cycle of the chip's own phase table — 1024 unsigned bytes, the resolution the chip itself reads at, in each of its four wave shapes. The rest maps field for field:

| OPL | Taud |
|---|---|
| `waveSel` | which of the four single-cycle samples the operator's instrument points at |
| `totalLevel` (0…63, 0.75 dB a step) | the rack entry's mix octet |
| `multiple` | the rack entry's detune, as a frequency ratio in 4096-TET units |
| attack / decay / sustain / release / `eg` | the operator instrument's volume envelope, in real seconds |
| `ksl` (key level scaling) and `ksr` (key rate scaling) | pitch-BANDED entries — §8.3 |
| `feedback` | a `$08xx` z⁻¹ tap on the modulator, scaled by a DC operator |
| `connection` | FM is `$0001 $0400`; additive is a DC gate ring-modulating the sum |
| `am` (tremolo) | **nothing** — 1.0 dB at 3.7 Hz has no Taud analogue |
| `vib` | the instrument's auto-vibrato, at the chip's 7 cents and ~6.08 Hz |

Two of those need saying properly.

**The modulator's mix octet is its modulation index.** On the chip a full-scale operator displaces the next one's phase by 4084/2 out of a 1024-step cycle — 1.994 whole cycles — and a Taud modulator at unity sweeps ±1 cycle, so a modulator's octet carries a fixed ×1.994 (octet 207 at total level 0) that a carrier's does not. Get this wrong by a factor of two and every patch comes out dull.

**A constant is a DC operator.** A rack has no word that pushes a literal, so where the conversion needs to scale something by a number — the feedback tap, which the chip shifts down by `8 − feedback` — the algorithm ring-modulates by an operator whose sample is a constant `+1` and whose mix octet *is* the factor. The same trick does additive patches: operator 0's envelope belongs to the whole note, so an additive patch, whose two operators must each keep their own, makes operator 0 a DC **gate** that shapes nothing and holds open long enough for both to finish.

### 8.3 Key scaling becomes key bands

`ksl` attenuates an operator for playing high and `ksr` speeds its envelope up; neither has an expression in a mix octet or a list of times in seconds. What a rack *can* do is gate an entry by pitch — so an operator becomes several entries over disjoint key bands, each pointing at its own instrument carrying that band's envelope and level. Only one of them is ever inside a trigger's rectangle, so the rack still sounds one voice per operator and the cost is instrument slots rather than voices. The bands are fitted to the notes the song actually plays the patch at, which is why most patches need only one or two.

### 8.4 Rhythm mode

`soundMode == 1` puts five drums on channels 6…10, and three of them are not oscillators at all: the chip throws away the hi-hat's, snare's and top cymbal's phase accumulators' low bits and builds a phase out of single bits of two of them XORed against its noise LFSR. There is no rack that does that, so those three are **rendered to a looped waveform** at unit envelope and the OPL envelope is carried by the instrument record exactly as it would have been by a rack operator. The bass drum is an ordinary two-operator voice and the tom an ordinary oscillator; both stay racks and keep their pitch.

The three rendered drums are baked at the driver's starting tom pitch, because channel 7 and 8's F-numbers — which is what their timbre is built from — follow the tom. A song that plays tom notes shifts them on the chip and does not here.

### 8.5 Volume is logarithmic

`An vv`, and the velocity byte of a note-on, both set **channel** volume 0…127 — and AdLib's volume is not a linear gain. The driver scales the operator's 6-bit *amplitude*, which is a 0.75 dB-per-step logarithmic quantity, so volume 64 is 23 dB down and not 6. Converting it as if it were linear makes every fade in the format arrive far too late and far too suddenly. The exact curve depends on the operator's own total level, so the converter tracks which patch is on the channel and writes the resulting gain into the **volume column** — leaving the effect column free for the pitch bends, which need it far more.

### 8.6 Bends are the loss

IMS uses 2.6 million pitch-bend events across the reference corpus. They are not an ornament: they are how the format writes portamento and vibrato. They are followed here with **fine pitch slides** (`E`/`F` with a `$F` high nibble), which fire once on tick 0 — so the pitch is exact at every row boundary and what is lost is the shape in between. On the usual 8-to-12-rows-a-beat grid that is a bend updated every 20 to 60 ms, which reads as portamento correctly and flattens a fast vibrato.

### 8.7 Everything else

- **Tuning is A4 at 440 Hz and the notation index is 12-TET**, which the engine reads as an exact identity — nothing is scaled at playback. The chip's own middle C is 261.719 Hz, six tenths of a cent above concert, and declaring *that* instead would make a converted note sound exactly where an AdLib card put it; the trade was made the other way, because 0.6 cents is inaudible and a song fractionally out of tune with everything it might be remixed alongside is not. Every note moves by the same amount, so nothing within the song shifts relative to anything else.
- **A cue is a whole number of bars.** A pattern holds 64 rows and 64 is not a multiple of every bar this format produces — 12 rows a beat in 4/4 is 48, which would leave every cue straddling a bar line. A cue therefore plays the largest power-of-two count of bars that fits in a pattern, said with the `LEN` instruction (and `halt at x` on the last cue, which is one instruction rather than two sharing a cue's two words). Only a bar longer than a pattern falls back to the full 64.
- **Interpolation is off**: an OPL operator reads its phase table with no filtering at all, and its aliasing is part of the sound.
- **Mixing volume is 90**, which puts one converted voice at exactly the 0.249 of full scale a single full operator reached on the chip's 16-bit DAC. Matching the headroom is what keeps a song's dynamics where they were.
- **Titles are 2-byte Johab Korean** and are decoded and written as the project name, through the `\uHHHH` escape convention names ride. The title is the only attribution these files carry and it usually holds the artist as well, so it is kept whole.
- **Patch changes mid-note** are applied at the next trigger, not immediately as the chip does.
- **An unresolved patch name is a silent slot with the name preserved**, never a failed conversion. Resolution is most-specific-first and case-INSENSITIVE: exact matching resolves 29 % of the corpus's references and case-folded matching 99.95 %.

## 9. Verifying a conversion

Some practical checks, roughly in order of how much they catch per minute spent:

- **Play it against the reference engine, not only your own.** Bit-exact agreement between engines is the format's conformance bar, and a converter bug often shows up as an engine disagreement first.
- **Check the first and last bars.** Cue HALT placement, partial final bars and loop seams all fail at the ends, where a quick listen through the middle will not notice.
- **Check a mid-song tempo or time-signature change.** Grid choice, cue breaking and `T` emission all meet there.
- **Check a note that starts bent, and a note that bends across a bar line** (MIDI), or **a slide that crosses a pattern boundary** (modules). Effect memory and recall resolution show up here.
- **Check an instrument with a keyboard split.** If Ixmp went missing — a stray `--no-project-data`, or a reader that ignores Project Data — every split instrument collapses to one sample, and it is obvious once you know to listen for it.
- **Check the loudest passage.** Pool overflow resampling, mixing-volume headroom and clipping all surface at peak polyphony.
