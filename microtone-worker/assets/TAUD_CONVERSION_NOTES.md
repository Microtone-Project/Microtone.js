# Taud Conversion Notes

This document describes how music in other formats becomes Taud: what maps cleanly, what has to be approximated, and where the traps are. It covers ProTracker (`.mod`), ScreamTracker 3 (`.s3m`), FastTracker 2 (`.xm`), ImpulseTracker (`.it`), Monotone (`.mon`), Standard MIDI plus SoundFont 2 (`.mid` + `.sf2`), and the AdLib music of Iyagi Music Sound (`.ims` + `.bnk`) and the Korean OPL3 tracker (`.sop`).

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
| Lanes | 32, or 64 with `xHDR` | Excess lanes are dropped |
| Pattern rows | 64 | Longer patterns are split ([§1.4](#1-4-patterns-are-single-lane)) |
| Patterns | 32 767 | Practically bounded by `patterns × lanes` |
| Cues | 8192, or 4096 in 64-lane mode | — |
| Ixmp patches per instrument | Unbounded, but rectangles **MUST NOT** overlap | — |

The pattern budget is the one that bites first on wide modules, because a Taud pattern holds one lane: a 20-lane module with 64 source patterns needs 1280 Taud patterns before deduplication. The reference converters treat `patterns × lanes > 4095` as a hard error for the ≤ 20-lane formats.

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

Whatever resamples a looped sample, the loop **MUST** keep its length in time. A loop is a whole number of frames, so scaling its two ends and rounding each separately moves the pitch of everything it sustains, by up to a frame in a loop that may be a dozen frames long — most of a semitone on a single-cycle synth wave. Round the loop's *length* once, take that sample's ratio from it (new length over old), and derive the stored sampling rate and the loop start from that ratio. Derive the rate from the ratio the resampler actually applied, too, never from the output length over the input length: truncating the output to whole frames makes that quotient smaller than the true ratio, and leaves every short sample a little flat.

### 1.3 Pitch

Every source pitch becomes a 4096-TET note word anchored at C4 = `$5000`:

| Source | Conversion |
|---|---|
| ProTracker period | `round($5000 + 4096 × log2(428 ÷ period))` |
| Semitone index *n* relative to C4 | `round($5000 + n × 4096 ÷ 12)` |
| Frequency *f* Hz | `round($5000 + 4096 × log2(f ÷ 261.6255653))` |

Per-sample tuning offsets — XM's `relative note` and `finetune`, IT's C5 speed, SoundFont's `originalPitch` and `pitchCorrection` — are baked into the instrument's **sampling rate at C4** field, or into its signed **sample detune** field, rather than being pushed into every note. That keeps the pattern readable and lets a retune operate on musical pitches.

One semitone is ≈ 341.33 units and one cent is ≈ 3.41 units, so slide arguments generally need scaling; each format's section gives its factor.

### 1.4 Patterns are single-lane

This is the structural difference that shapes every converter. A source pattern of *R* rows × *C* channels becomes *C* Taud patterns of *R* rows, and the cue that plays them names all *C* at once.

Consequences:

- **Row counts other than 64** need the cue's LEN instruction (`rows − 1` in the low six bits). A pattern longer than 64 rows is split into ⌊rows ÷ 64⌋ full cues plus a remainder cue carrying LEN.
- **Splitting renumbers the order list**, so every `B` (position jump) and `C` (pattern break) target **MUST** be remapped to the new cue indices.
- **A pattern loop (`S $Bx`) that straddles a split boundary cannot work**, because the loop is per-cue. Converters warn rather than silently mangling it.
- **Deduplication pays for itself.** Identical 512-byte patterns collapse to one copy with a remap table; on a typical module most single-lane patterns are empty and fold into one.

### 1.5 The cue sheet

A converted song's cue sheet needs three things right:

- **HALT goes on the last active cue**, not in an empty cue appended after it. Appending leaves a silent 64-row gap before playback stops.
- **A partial final bar uses HALT AT** *x* rather than plain HALT, so the song ends at its own length.
- **Trailing empty cues are trimmed** — a cue is empty only when every lane word is the no-pattern sentinel *and* both instruction words are NOP.

Looping is a cue **JMP** back to the loop-start cue, replacing that cue's HALT. When the loop start is mid-cue, an in-pattern `B` (plus `C` for the row) does the job instead.

### 1.6 Effect memory

Most trackers back their effects with per-effect or shared memory: re-issuing a command with a `$00` argument recalls the last non-zero one. Taud has memory too, but **its cohorts are narrower than ST3's or IT's**, so a naive pass-through changes which value gets recalled.

The reference converters therefore **resolve recalls eagerly**: they walk the patterns in order-list order, per lane, tracking the source's own memory model, and substitute the concrete value before encoding. The known limitation is honest and worth stating: a pattern reached from several order entries is rewritten on its first visit, so a later visit may diverge from the original if the memory state differed. In practice this is inaudible on real modules, but it is a real difference and a converter **SHOULD** document it rather than pretend otherwise.

### 1.7 Volume and pan columns

Taud's volume and pan columns each carry a 6-bit value plus a selector, and the FINE selector with value 0 is the canonical **no-op** (byte `$C0`). Two conventions follow:

- On a row that triggers a note but carries no explicit source volume, emit a **SET** with the instrument's default volume. Otherwise the lane's prior volume persists into the fresh note, which is almost never what the source meant.
- On every other row, emit the FINE-0 no-op so the column does not disturb running state.

A source volume of 64 maps to **63**, not to a rescaled value. ST3, XM and IT all display a 0…64 volume and all clamp it to six bits in the player, so 64 and 63 sound the same at the source; scaling the whole range by 63/64 to make 64 "fit" would quietly pull every other volume in the song down. Clamp, do not scale.

Effects that only set lane volume or panning (`M`, `N`, `X`, `P` in ST3 terms) **SHOULD** be folded into these columns, which frees the effect slot for something that genuinely needs it. Each cell has exactly one effect slot, and on dense material that slot is the scarcest resource in the whole conversion.

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

AdLib instruments become OPL instruments ([§3.5](#3-5-adlib-instruments)).

### 3.2 Shared-memory recall

ST3 backs effects `D`, `E`, `F`, `I`, `J`, `K`, `L`, `Q`, `R` and `S` with a **single per-channel memory slot**, so a `$00` argument on any of them recalls whatever any of them last set. Taud's cohorts are narrower, so the converter resolves every such recall eagerly ([§1.6](#1-6-effect-memory)).

### 3.3 Numeric quirks

- **`Cxx` is BCD on disk.** `$10` means decimal row 10, not hex row 16. Decode as `(byte >> 4) × 10 + (byte & $F)`; anything decoding to 64 or above clamps to row 0. (IT's `Cxx` is plain binary — the two formats differ here and mixing them up shifts every pattern break.)
- **The coarse pitch-slide unit is 1/16 semitone**, ≈ 21.33 Taud units, so `E`, `F` and `G` coarse arguments are multiplied by `$0015`. Fine forms are packed into Taud's `$F0xx` fine form after the same per-step scale.
- **Global volume is 0…$40**, scaled to Taud's 0…$FF by ×4 with a clamp.
- **Tempo** is a raw decimal BPM; Taud's byte is biased −25. The converter also scans row 0 of the order list's first pattern for `A` and `T` and prefers those over the header defaults, because that is where trackers actually put the intended tempo.

### 3.4 Default panning

Row 0 of every pattern emits a pan-column SET derived from the S3M channel-setting byte — channels 0…7 left (`$10`), 8…15 right (`$2F`), otherwise centre (`$1F`). Every other row emits the FINE-0 no-op unless an `X`, `P` or `S $8x` overrides it.

### 3.5 AdLib instruments

An S3M instrument of type 2 is an **AdLib melody instrument**: twelve register bytes for one two-operator channel of a YM3812, where a sample instrument has its sample. It becomes an **OPL instrument** — Metainstrument type 8 ([File Format §7.7](TAUD_FILE_FORMAT.md)) — which the engine plays as the chip plays it ([Engine Spec §5.5.2](TAUD_ENGINE_SPEC.md)), so the registers go across bit for bit and nothing is compiled. The AdLib **drum** types 3…7 stay silent, as they are in ST3 and in OpenMPT.

ST3 is long gone from any machine that would play it, so **OpenMPT is the reference** here, and `openmpt123` the oracle every number below was checked against:

- **The patch** is bytes `$10…$1B`: the modulator then the carrier for registers `$20`, `$40`, `$60`, `$80` and `$E0`, then `$C0`. The wave selects keep all three bits, because OpenMPT runs the chip in OPL3 mode.
- **Pitch** comes from the instrument's C2SPD, which becomes the OPL instrument's rate: at 8363 the note C-4 sounds concert middle C, which is OpenMPT's mapping. A C2SPD of 0 reads as 8363, one below 1024 as 1024, and an ST3 file's AdLib C2SPD keeps only its low 16 bits.
- **Volume is total level, not gain.** OpenMPT turns the 0…64 volume into the carrier's attenuation, `63 − (63 − TL)·(v′ + 1) ÷ 64` with `v′` the volume scaled to 0…63 — so volume 32 is 23 dB down rather than 6, and volume 0 is 47 dB down rather than silence. The default volume and every volume SET are converted on that curve. A volume **slide** stays a linear slide, which is where the conversion is approximate; and the volume column is six linear bits, so a level quieter than about −36 dB has no step of its own.
- **`^^^` keys the channel off.** OpenMPT: "OPL voices are not cut but enter the release portion of their envelope". On a sample it is still the cut it always was.
- **An AdLib channel starts centred**, whatever the panning table says, as OpenMPT reads an ST3 file.
- **Loudness against the samples** is OpenMPT's own calibration — its `m_nVSTiVolume` of 36 for an S3M, "as loud as in DOSBox and a real SoundBlaster 16". There a full-volume AdLib sine sits 5.40 dB under a full-scale square sample, both centred; converted and rendered here it sat 2.98 dB under, so every OPL instrument carries another 2.4 dB of attenuation in its record.

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

### 5.1 Channels → lanes

The converter takes the non-muted, in-use source channels: 32 or fewer stay in the default layout, 33…64 switch the file to **64-lane mode** (the `xHDR` flag), and only a song exceeding 64 active channels is capped. A lane is "muted" when its pan byte has bit 7 set or reads `$C0`, and "in use" when any cell on it is non-empty.

### 5.2 Instruments and Ixmp

Each IT instrument becomes **one** Taud instrument, whose base record carries the C5 canonical sample, plus an Ixmp patch list covering every keyboard cell that maps to a different sample. Patch rectangles are contiguous runs of keyboard cells pointing at the same sample, which guarantees the no-overlap rule because the keyboard map is itself a partition.

Per-patch fields mirror what the base record would have stored for that sample — loop points and mode, default volume and pan, auto-vibrato — so a patched note behaves exactly as a base-record note on the same sample would.

Volume, panning and pitch-or-filter envelopes convert natively, with up to 25 nodes, both sustain and loop regions, and the `P` presence bit set whenever nodes are emitted. Auto-vibrato, fadeout, pitch-pan centre and separation, default pan, volume and pan swing, and initial filter cutoff and resonance all forward to their instrument fields. OpenMPT's OPL samples become OPL instruments ([§5.8](#5-8-opl-samples)).

IT2.14/IT2.15 **compressed samples** are decoded during conversion. The compression flag is per sample (bit 2 of the sample's `cvt` byte), *not* global via the file's `cwt` — reading it globally mis-decodes mixed files.

**Stereo samples are kept by default**: the two channels become two pool spans joined by an Ixmp `s` patch. Because a base record cannot express a stereo sample, a stereo canonical sample is treated as non-canonical and gets patches over its own keyboard runs. Downmixing to mono is available as an option.

### 5.3 Sample-mode files

An IT file that does not set the "use instruments" flag has no instrument records at all — pattern cells name samples directly. Such a file gets one Taud instrument per sample, and every field that only an IT instrument could have fills in with its neutral value: no envelopes, no fadeout, no pitch-pan, filter off.

The fields an IT **sample** carries in its own right still convert: its default volume, its default pan (`IMPS+$2F`, when the sample's own use-panning bit is set) and its auto-vibrato.

**`Vir` = 0 means the sample has no auto-vibrato**, however deep its `Vid`. IT's rate field is the only thing that lifts the depth accumulator off zero, so a sample that names a speed and a depth but leaves the rate at zero is silent in IT and in OpenMPT. Taud reads a record with both ramp fields at zero as full depth from the first tick — the FT2 convention, and the one the instrument editor needs — so the conversion carries that silence as a depth of 0 rather than as the rate it came from.

**New Note Action is the one field where "neutral" is not zero.** Sample mode has no NNA: a new note replaces whatever the lane was playing, exactly as in `.mod`, `.s3m` and `.xm`. Converted samples therefore get NNA = Note Cut, so no ghost is spawned. Note Off — the value the field's zero encodes — would keep a ghost running per trigger, and with no volume envelope and a fadeout of zero it would never stop ringing.

### 5.4 Pattern splitting

IT patterns may exceed 64 rows, and are split into ⌈rows ÷ 64⌉ consecutive Taud patterns. `B` and `C` targets are remapped onto the new cue indices; an `S $Bx` pattern loop crossing a chunk boundary is warned about, since a Taud loop cannot span cues.

### 5.5 Note delays past the row

IT triggers a note delay *during* the current row, so a delay of `x` ticks with `x ≥ speed` never lands — the note is silently lost. The converter relocates such a note to the next row with `delay = x − speed`, but only when that next row on the same lane is empty. This recovers notes that IT itself would have dropped, which is a deliberate deviation in favour of the music.

### 5.6 Portamento eats the instrument byte

IT does not reset an instrument's envelopes when a row carries a note, an instrument number **and** a tone portamento. With Compatible Gxx off — the ordinary case — such a row never reaches the envelope reset at all, so the envelopes carry on from the previous note whether or not the instrument's Carry flag is set. Schism's own comment on the surrounding conditions is "experimentally determined… seems like it's just a total mess"; OpenMPT carries the quirk as `kITPortamentoInstrument` / `kITEnvelopeReset` and was still correcting corners of it in 1.32.11.

The Taud engine deliberately does not reproduce it: an instrument byte on a portamento row re-attacks the four playheads (TAUD_ENGINE_SPEC §5.2), which is FastTracker's rule and the one a tracker musician can predict. Envelope carry is spelled out instead, in the LOOP word's `c` bit, where it is a property of the instrument rather than an accident of the row.

So the converter resolves it at conversion time: **a note tied by `G` or `L` that names the instrument the lane is already holding is written without the instrument byte**, which is what an IT author's ear expects and how the passage would be written by hand. The byte is dropped only when it names the *same* instrument — that is precisely the case where IT reloads nothing, so nothing else goes with it. A portamento row naming a *different* instrument keeps its byte: there IT does swap the sample and clear the key-off, and the Taud re-attack is much the closer of the two readings.

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

### 5.8 OPL samples

Impulse Tracker never had AdLib instruments, but OpenMPT stores its own OPL instruments in IT-structured files (`.mptm`, and an `.it` it has loaded one into) as an ordinary sample header whose `cvt` byte is `$40`, the "sample data" being the same twelve register bytes as an S3M AdLib instrument ([§3.5](#3-5-adlib-instruments)). Each becomes an OPL instrument and keeps the IT instrument around it — its envelopes, NNA, fadeout and the rest. Everything §3.5 says holds, with these differences:

- **The curve goes everywhere OpenMPT multiplies a volume in**: the default volume, a volume SET, the sample's and the instrument's global volume, and the volume envelope's nodes. Slides, fadeout and the song's own volumes stay linear.
- **The filter cutoff is the modulator's level.** OpenMPT reads an instrument's cutoff as "modulator intensity for FM instruments": a set, enabled cutoff is folded into the modulator's total level on the same curve and the instrument's own filter is opened. A pitch/filter envelope in filter mode drove the modulator the same way and has nothing to drive here, so it is dropped rather than turned into a filter sweep.
- **There is no keyboard map**: an instrument whose sample is OPL plays it on every note.
- **No extra attenuation.** OpenMPT plays an IT-structured file's OPL at its `VSTV` song setting, 48 unless the file says otherwise, where an S3M gets 36; a full-volume OPL sine sits 2.90 dB under a full-scale square sample there and 2.98 dB under it converted. A file that sets its own `VSTV` is not read.

## 6. Monotone — `.mon`

Monotone is Calvin "Trixter" French's tracker for the PC speaker, Tandy and TI-99 SN76489. It has no user-defined instruments — the only instrument is the beeper — 1…12 lanes, 64 rows per pattern, ProTracker-flavoured 2-byte cells, and eight effects: `0`, `1`, `2`, `3`, `4`, `B`, `D`, `F`.

### 6.1 The instrument

The converter synthesises a single instrument: a 32-byte, 50 %-duty square wave at offset 0 of the pool, looping forward, with a sampling rate of 8372 Hz so C4 sounds at 261.6 Hz. Its instrument global volume is set to `$A0` for headroom (a square wave is loud), its default note volume to full, its filter off, and its NNA to Note Cut. Every Monotone lane plays this one instrument.

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

This is the least mechanical conversion: MIDI has no patterns, no rows and no lanes, and a SoundFont is a sampler bank rather than a tracker instrument list. Almost everything here is a judgement call.

### 7.1 The rhythmic grid

MIDI time is continuous; Taud time is rows and ticks. The converter chooses **rows per beat** and **ticks per row** together, from the tempo map, the time signatures and an analysis of which onset subdivisions the song actually uses. The chosen `rpb × speed` fine-ticks per beat must represent the finest subdivision in use, keep every tempo inside the 25…1048 BPM register, and stay near the proven 24-fine-ticks-per-beat grid — so plain 4/4 at 120 BPM still comes out as the familiar speed 6, 4 rows per beat.

Pinning either axis on the command line auto-fits the other; pinning both overrides the analysis entirely.

As a final step, a bend- or polyphony-heavy song with fewer than 8 rows per beat has its `rpb` doubled and its `speed` halved (leaving tempo and `F` unchanged), up to 8. The extra rows give key-offs, choke events, portamento and lane-volume effects distinct rows to land on, so fewer are lost to same-row collisions — each cell has only one effect slot.

Sub-row timing is then carried by `S $Dx` note delays.

**The declared tempo may not describe the events at all.** Some MIDIs are internally consistent but written on a grid that is not the file's quarter note: the beat is 1.2 or 1.35 quarters long, so bar lines fall mid-phrase, rows-per-beat means nothing, and every analysis above measures against the wrong unit. It happens whenever the tick clock is really a fixed rate — a tempo of 60 at 240 PPQ is 240 ticks per *second*, not a musical tempo — and whenever a part was typed in against the wrong project tempo. The repair is a **rescale, not a rewrite**: multiply every event tick *and* every tempo by one factor `r`. Wall-clock timing is then preserved exactly, since each tick is `r` times shorter and there are `r` times as many of them; no note moves relative to any other; and choosing `r` so that the music's own beat becomes one quarter note leaves the file declaring the tempo it actually plays at. A converter **MUST NOT** snap anything as part of this — quantisation is the separate, later step below, and the two compose.

`r` has two possible sources and a converter needs both. The operator's own figure, `r = wanted ÷ declared`, is the only thing that can help a file whose grid is *fine* and whose tempo number alone is wrong, because that fault leaves no trace whatsoever in the event positions. Otherwise the beat is inferred from the onsets: cluster near-simultaneous note-ons so that a spread chord counts once and carries its size as accent weight, take candidate periods from a harmonic comb over the inter-onset-interval histogram, then sharpen each candidate into an exact period by maximising the onset train's **phase coherence** — the length of the weighted mean unit vector at that period, 1 for a perfect grid and 0 for none. Coherence is the right statistic because it needs neither a tolerance nor a phase guess: a least-squares fit over a long song locks onto a period a hundredth of a percent out and then reports the accumulated drift as if the music itself were ragged.

What no timing analysis can settle is the **metrical level**. A stream of eighths at 162 BPM and one of sixteenths at 81 are the same set of onsets. The beat is some whole number of grid units, and choosing which number is a judgement: weigh how ordinary the resulting tempo is, how far it moves the file from what it declares, and whether onset weight really does cluster on that level. A converter **SHOULD** report the reading it chose together with the alternatives, and **MUST** offer the operator's override. Two refusals are required as well. When the ratio comes out at 1 the file is already on its own grid and **MUST** be left exactly as it was — a realignment offered by default is worthless if it perturbs healthy files. When coherence is low the onsets are not a mis-tempoed grid but no grid at all, which is what a rubato performance looks like, and a converter **MUST NOT** invent a beat for it.

**Nothing is quantised unless the operator asks.** A MIDI that was *played* rather than stepped in carries its performance in exactly those sub-row delays, and a converter that tidied them away by default would be discarding the take. An opt-in quantiser snaps notes onto a beat subdivision — the one the onsets already use, the row grid, or a named fraction — and its strength dial says how far each end moves, so a light setting tightens sloppy playing while leaving a deliberate push or drag audible.

**Both ends are snapped, not just the onset.** Moving the onset alone leaves every release exactly as ragged as it was played, so the sub-row delays this was meant to clear up survive on the key-offs. A quantised note therefore lasts a whole number of grid steps — with one floor: a note shorter than half a step has both ends land on the same grid point, and it **MUST** keep the shortest length the grid can hold rather than being stretched to a full step, or every drum hit and grace note in the file becomes a sixteenth.

That floor is the only thing that can leave an overlap **shorter than one step** behind, because everything else now sits on the grid and overlaps by whole steps. Within one channel and one key such an overlap is impossible in the source — nothing strikes one key twice at once — so a converter **SHOULD** resolve it: shorten the earlier note to the later one's onset, or, when both landed on the same grid point, drop it, since two strikes collapsed onto one instant are one strike. The same test **MUST NOT** be applied across different keys of one lane: a kick sounding under a hi-hat overlaps in exactly that way and is not an accident. Quantising runs after the grid has been chosen, because the picker reads the raw onsets and must see the timing the performance was aiming at rather than one this pass has already imposed. A converter offering this **SHOULD** warn that it erases swing, flams and grace notes along with the mistakes.

Tempo changes become `T $xx00`, or one of the extended forms `T $FFxx` … `T $FCxx` above 280 BPM. MIDI channel volume and expression (CC7 × CC11) become `M $xx00` lane-volume effects, deliberately **not** volume-column writes: the volume column is the velocity axis that selects Ixmp patches, and driving it from CC7 would change which sample plays. Like velocity ([§7.4](#7-4-soundfont-presets-to-taud-instruments)), each controller reaches the level through the SoundFont's default 960 cB concave curve, so the lane volume is (CC7 ÷ 127)² × (CC11 ÷ 127)², not the plain product: CC7 at its default of 100 is `M $2700`, not `M $3200`.

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

Each preset's zones are partitioned into the fewest mutually **disjoint** layers (default cap 4, and about 93 % of big-bank presets fit in 4, 98 % in 5). Each layer becomes one ordinary Taud instrument with its zones as Ixmp patches.

**Velocity is not volume.** A patch's volume range selects on the trigger's note volume, and the engine plays that same number as linear amplitude. A SoundFont velocity is neither: the player turns it into attenuation through a modulator — by default 960 cB on a concave curve, which works out to −40·log₁₀(velocity ÷ 127) dB, amplitude (velocity ÷ 127)² — that a bank may override per instrument and add to per preset. GeneralUser GS re-scales it on nearly every instrument, usually to 800 cB, and to 0 on its velocity-insensitive patches. Rounding velocity linearly onto 0…63 gets both halves wrong: a velocity-64 note plays 6 dB too loud, and a tracker volume of 32 — half amplitude — selects the velocity-64 layer, which the SoundFont plays 12 dB down.

A converter **MUST** therefore resolve each zone's velocity curve the way FluidSynth does — the default modulator first, an identical instrument modulator replacing its amount, an identical preset modulator adding to it — and map velocity through that curve. A note is written at the volume its velocity plays at, relative to the loudest velocity, rounded in decibels; a zone's volume range is every note volume whose velocity lies in the zone's range. Built that way, velocity-adjacent zones meet without gap or overlap, and a note selects the zone the SoundFont would.

**One curve per key.** A trigger has one volume for every layer it reaches, so every zone sounding at a key must sit on the same curve, or the layers would disagree about which velocity a volume stands for — GeneralUser GS's snare lays a 529 cB zone over a 900 cB one in each of its velocity bands. The key takes the curve that covers most of its velocity range. A layer on a different curve makes up the difference in its initial attenuation — a boost, where its curve is flatter — split into velocity bands when that difference varies by more than about 1 dB across its range. A curve too flat to tell a key's velocity layers apart, or one that grows quieter as velocity rises, gives way to the default curve.

**The six-bit axis has a floor.** Note volume 1 is −36 dB, so on the default curve every velocity below 19 plays there, where the SoundFont would play it as low as −84 dB. A zone whose whole velocity range sits in that region, a sliver a few velocities wide, has no note volume to select it and is dropped.

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

SF2 `initialAttenuation` is a per-zone static gain, and it goes into the dedicated **initial-attenuation octet** — the base record's for the canonical zone, a patch's own for any zone that differs — not into the volume envelope, where a heavily attenuated zone would be left with a peak of 3 and a tail of 0. It multiplies with the note volume, so velocity layers differ in level as well as in ADSR shape; it cannot live in the patch's default note volume, which an explicit volume column overrides at trigger time. FluidSynth scales the generator by 0.4 before using it (the EMU hardware convention), and a converter **MUST** too, or every attenuated instrument comes out too quiet against the rest. The same octet carries a minority layer's velocity correction ([§7.4](#7-4-soundfont-presets-to-taud-instruments)).

Melodic instruments get the **key lift** flag, so key-off behaves like a MIDI key release: the volume envelope jumps straight to its sustain end and the release plays at once, instead of ringing on through the remaining pre-sustain nodes like a depressed sustain pedal.

### 7.6 Polyphony

Polyphony rides on New Note Actions, which is what makes MIDI-shaped music fit a tracker at all. Every instrument, drum kits included, gets **NNA = Note Fade**: a lane becomes reusable the moment its note releases, and the release tail moves to a background ghost that dies over its own release time.

The lane budget defaults to 32. A song exceeding it releases the oldest pedal-held or soonest-ending note **early** rather than cutting it. Raising the budget above 32 opts into 64-lane Taud mode, but only takes effect if the song actually allocates 33 or more lanes.

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

**Iyagi Music Sound** is the music format of *Iyagi*, the Korean BBS terminal of the early 1990s: an AdLib `.rol` score converted to a MIDI-shaped event stream at 240 ticks per beat, played on a YM3812 (OPL2). Two things make it unlike every other source here. The song **names** its instruments instead of storing them, so a companion `.bnk` bank is not optional — without one nothing sounds. And its instruments are not samples at all but **two-operator FM patches** for a YM3812, so its output has no samples either: every instrument is an **OPL instrument**, Metainstrument type 8, which the engine plays as the chip does.

### 8.1 The grid comes from the delta times

ROL was a step sequencer, and the converter that turned it into an event stream only rescaled the clock — so the **greatest common divisor of every delta time IS the composer's original tick**, and `240 ÷ gcd` is the rows per beat. Every GCD observed across 1128 reference songs divides 240, so the grid is exact and no event is quantised away. Header byte 50 states the same number outright in the 59 files that set it, and it agrees with the GCD in all of them; it is a cross-check, not a shortcut, because the other 1069 leave it zero.

Speed and BPM are then one equation with a free parameter — a row lasts `speed × 2.5 ÷ BPM` seconds — and the parameter is spent on making the **tick as short as an 800 BPM ceiling allows**. The tick is the resolution of every per-tick effect, and the bends of §8.6 are made of them. A typical song lands between 700 and 800 BPM, so its tick is about 3.3 ms rather than 20. (The chip's own envelopes run at its own 49 716 Hz in the engine and do not depend on the tick at all.) A tempo change re-solves the same equation and writes `A` and `T` on two lanes of the same row.

### 8.2 An OPL patch is an OPL instrument

Each patch the song names is written as a type-8 Metainstrument ([File Format §7.7](TAUD_FILE_FORMAT.md)): an ordinary instrument record with the patch's registers where its sample would be, which the engine runs as the chip runs them — its log-sine and exponential tables, its envelope generator, key scaling, feedback, the tremolo and vibrato LFOs and the rhythm drums' phase equations, at the chip's own 49 716 Hz ([Engine Spec §5.5.2](TAUD_ENGINE_SPEC.md)). So nothing is compiled; the registers are written down.

| OPL | Taud |
|---|---|
| a patch's operator and connection registers | the record's OPL block, bit for bit |
| a rhythm-mode drum | the instrument's kind — §8.4 |
| channel volume | the volume column, on the driver's decibel curve — §8.5 |
| key-on and key-off | a note and a key-off |
| `am`, `vib`, `ksl`, `ksr`, feedback, wave select | the chip's own, run by the engine |

**Every instrument gets NNA = Note Cut**, which on an OPL instrument means what a retrigger means on the chip: the next note keys the **same** channel on again, its envelopes carried on from wherever they had got to rather than started from silence. Any other NNA would leave a ghost of the old note ringing beside the new one, which an OPL channel cannot do — it is monophonic.

**The release is the chip's.** A key-off switches each operator's envelope to its release rate wherever it had got to, attack and decay included, which is what made a release so hard to carry when the patch had to be compiled into something else. Until 2026-10-14 this conversion built an FM rack out of single-cycle samples for every patch, and with it went a list of approximations — the modulation index, the feedback scale, release as a fadeout, key scaling as pitch bands, auto-vibrato standing in for the chip's LFO. All of them are gone. Against the IMS Archive player over 43 corpus songs the envelope of a conversion now correlates at 0.993 on average; on `000-TEMA` the rack conversion's level was 1.87 dB off and its waveform correlation 0.66, and the OPL instruments' are 0.25 dB and 0.957.

Two readings follow the hardware rather than the application manual (Engine Spec §5.5.2): **key scale rate** reads the F-number's top bit unless the note-select switch says otherwise, and **key scale level**'s two gentler settings keep the fraction the chip keeps. The IMS Archive player took the same two readings on 2026-10-14, so the engine and the player now agree to the bit.

### 8.3 A drum is twice as loud as the same operator on a melodic channel

In rhythm mode the chip sums channels 6, 7 and 8 into its accumulator **twice over**, so the five drums sit 6 dB above where their operators would sit on a melodic channel. The engine does that itself for an OPL instrument whose kind is a drum, so a converter writes nothing for it — and must not compensate for it either. It is worth knowing that this one claim is **second-hand**: every emulator that implements it reports it as verified against a real YM3812, but the application manual documents the drums only as tonal advice and says nothing about the mix.

### 8.4 Rhythm mode

`soundMode == 1` puts five drums on channels 6…10, and each becomes an OPL instrument of its own kind: the **bass drum** a two-operator channel, the **tom** one plain operator, and the **snare**, **cymbal** and **hi-hat** one operator each whose phase is built, as the chip builds it, out of single bits of two phase accumulators XORed against its noise generator. The second accumulator belongs to a **partner**: the hi-hat's operator for the snare and the cymbal, the cymbal's for the hi-hat. The partner is another channel of the chip, so the instrument records what the drum needs of it: its multiplier, taken from the patch the partner's own drum plays, and its channel's pitch against the drum's own.

The pitches follow the driver. It tunes channel 8 — tom and cymbal — to the tom's note and channel 7 — hi-hat and snare — seven semitones above it, so the converter walks the song in event order and writes each drum's note from the tom note in force when it was struck: the cymbal at the tom's pitch, the snare and hi-hat seven semitones up, and every partner seven semitones away, up or down. What it does not follow is a drum already sounding when a later tom note moves its channel: on the chip that drum is retuned under its own feet, and here it keeps the pitch it was struck at.

### 8.5 Volume is logarithmic

`An vv`, and the velocity byte of a note-on, both set **channel** volume 0…127 — and AdLib's volume is not a linear gain. The driver scales the operator's 6-bit *amplitude*, which is a 0.75 dB-per-step logarithmic quantity, so volume 64 is 23 dB down and not 6. Converting it as if it were linear makes every fade in the format arrive far too late and far too suddenly. The exact curve depends on the operator's own total level, so the converter tracks which patch is on the lane and writes the resulting gain into the **volume column** — leaving the effect column free for the pitch bends, which need it far more. The engine applies an OPL instrument's volume as attenuation on the operators that reach the output, which is what the driver did, so what reaches the chip is the level the driver wrote, to the nearest of the column's 64 steps.

### 8.6 Bends are the loss

IMS uses 2.6 million pitch-bend events across the reference corpus. They are not an ornament: they are how the format writes portamento and vibrato. They are followed here with **fine pitch slides** (`E`/`F` with a `$F` high nibble), which fire once on tick 0 — so the pitch is exact at every row boundary and what is lost is the shape in between. On the usual 8-to-12-rows-a-beat grid that is a bend updated every 20 to 60 ms, which reads as portamento correctly and flattens a fast vibrato.

### 8.7 Everything else

- **Tuning is A4 at 440 Hz and the notation index is 12-TET**, which the engine reads as an exact identity — nothing is scaled at playback. The chip's own middle C is 261.719 Hz, six tenths of a cent above concert, but that is inside the F-number's rounding: the engine re-derives the F-number from the sounding frequency, and a concert-pitch note lands on the one the AdLib driver wrote.
- **A cue is a whole number of bars.** A pattern holds 64 rows and 64 is not a multiple of every bar this format produces — 12 rows a beat in 4/4 is 48, which would leave every cue straddling a bar line. A cue therefore plays the largest power-of-two count of bars that fits in a pattern, said with the `LEN` instruction (and `halt at x` on the last cue, which is one instruction rather than two sharing a cue's two words). Only a bar longer than a pattern falls back to the full 64.
- **Mixing volume is 90**, which puts one converted voice at exactly the 0.249 of full scale a single full operator reached on the chip's 16-bit DAC. Matching the headroom is what keeps a song's dynamics where they were. A drum reaches twice that (§8.3).
- **Titles are 2-byte Johab Korean** and are decoded and written as the project name, through the `\uHHHH` escape convention names ride. The title is the only attribution these files carry and it usually holds the artist as well, so it is kept whole.
- **A patch change while a note sounds takes effect at once**, as on the chip, where the driver rewrites the keyed channel's registers and the release then runs at the new patch's rates. The converter writes an instrument byte with no note over the ringing note, which swaps the patch into the sounding channel, and restates the volume, whose curve depends on the new patch.
- **An unresolved patch name is a silent slot with the name preserved**, never a failed conversion. Resolution is most-specific-first and case-INSENSITIVE: exact matching resolves 29 % of the corpus's references and case-folded matching 99.95 %.

## 9. The Korean OPL3 tracker — `.sop`

`.sop` is the song format of **Note 1.0 Beta 2**, a Korean OPL3 sequencer by 이호범 (© 1995, 1997), found in the same BBS collections as the `.ims` files of §8 and sharing nothing with them but the chip family. Its magic, `sopepos`, is the author's HiTEL user ID. The structure below is `SOP_FORMAT.en.md` in the [iyagimusic-js](https://github.com/curioustorvald/IyagiMusic.js) repository, checked there against the corpus and corrected against a disassembly of `NOTE.EXE` itself.

**Note's own player is the reference.** It wrote every file, and its authors listened through it, so where the format leaves playback open the converter does what Note does — SOP_FORMAT §8, with the one exception in §8.1 there: bit 7 of the channel mode is the editor's disable switch, and two files were saved with solo on, so it is ignored.

Three things make it easier to convert than its `.ims` sibling:

- it **carries** its instruments rather than naming them, so there is no bank file and no patch can go missing
- its tick grid is the composer's own, so there is nothing to recover
- a note carries its own **length**, so there is no note-off to pair up

and one thing makes it harder: it is a **YMF262** format. Twenty tracks, stereo panning, eight wave shapes, and instruments that may be four operators rather than two. Taud has room for all of it, so — unlike playing the same file on an OPL2, where 298 of the 336 reference files ask for more melodic voices than the chip has — nothing here is a reduction.

Everything in §8.2 (an OPL patch is an OPL instrument), §8.3 and §8.4 (the rhythm drums) and §8.5 (volume is logarithmic) applies unchanged: the two formats share one instrument writer. One flag differs: Note keeps every F-number between 343 and 685, an octave block lower than the AdLib driver picks for the same note, and key scale rate and level read the block — so every SOP instrument sets the OPL instrument's **low F-number range** switch, and is as bright and as quick as Note made it. What follows is the rest of what differs.

### 9.1 One file tick is one row, and one track is one lane

An `.ims` is a ROL score rescaled onto a 240-tick MIDI grid and has to have the composer's row grid recovered from the greatest common divisor of its delta times. A SOP was written on a tracker's own grid and says so: header `tickBeat` — 4, 6, 8, 12 or 16 — already **is** its rows a beat, and a 4/4 bar of the commonest value is 32 rows, half a pattern. Taking the GCD as well would be wrong twice over: it is 1 in 335 of the 336 reference files, so it buys nothing, and in the one file where it is not it would flatten a twelve-rows-a-beat grid to four and leave nowhere to write between the notes.

Tracks map the same way. The format has twenty of them because a YMF262 in rhythm mode offers fifteen melodic voices plus five percussion ones, and Taud has thirty-two lanes — so track is lane, one to one, with nothing allocated, shared or stolen, which is also how Note plays it. A track Note does not sound is not written: a **mode-0** track is the silent upper half of a four-operator pair, whose events are kept from before the pair was joined, and without rhythm mode tracks 9 and 10 are no channel at all. Trailing tracks with nothing to play are left out.

Speed and BPM are solved as in §8.1, against the same 800 BPM ceiling and for the same reasons: a typical song lands between 700 and 800 BPM, so its tick is about 3.3 ms rather than 20.

### 9.2 A four-operator instrument stays four operators

A type-0 instrument is two operator pairs, and on a YMF262 two channels are joined to play all four as one voice. It becomes a four-operator OPL instrument. The two halves each keep their own `CNT` bit, as the instrument's two channels' connections, and reading `CNT` as *"this half's first operator goes straight to the output instead of modulating"* gives the chip's four published connections at once:

```
  0,0   1 → 2 → 3 → 4          0,1   1 → 2 → 3, and 4
  1,0   1, and 2 → 3 → 4       1,1   1, and 2 → 3, and 4
```

Feedback belongs to operator 1 alone, because operator 3 is fed by the chain rather than by itself; the slave half's feedback has nowhere to act and the chip ignores it too.

61 of the 336 reference files carry four-operator instruments. **Only a mode-1 track plays one as four operators**, because Note joins a pair when the channel-mode table says so and never because of the instrument: a type-0 instrument on any other track plays its first pair alone, as it does in Note (30 tracks in 7 files). The reverse — a two-operator instrument on a mode-1 track — leaves the pair joined in Note, with operators 3 and 4 still holding the previous instrument; an instrument cannot carry another's operators over, so it plays as two operators. That is 1163 notes, 1140 of them in `4OPDANCE.SOP`.

### 9.3 Panning moves the lane

A SOP sets panning per track and it survives every note after it, which is the per-**lane** axis — so it is written as `S $80xx` and not into the panning column, whose SET is the per-note one. The format's three values are 0 = right, 1 = middle, 2 = left, and the chip's stereo switches really are hard, so `$FF`, `$80` and `$00` are the honest reading of them.

They are not equal in power, though. A centred channel is at full level on **both** outputs and a hard-panned one on one, so the centre carries twice the power; Taud's pan law spends equal energy at every position. A hard-panned lane therefore gives the 3 dB back through its volume column.

Any other value Note writes into the chip's 0xC0 register as it stands, which clears both stereo switches and silences the channel until the next valid pan. Five events in the corpus do it; in `V_1.SOP` it is the whole of track 19. The converter silences the lane through the **volume column** — every volume it writes is 0 until a valid pan comes — so the effect column is not spent on it. What such a value also does to the channel's feedback bits, until its next instrument, the OPL instrument does not follow.

A pitch slide takes the effect column ahead of panning on a row that wants both, because a late pitch is heard and a late pan barely is. Whichever loses is retried on the next row — an empty one, if need be — since the converter re-derives both from the state it has actually written. A tempo change outranks a pan in the same way: it needs some lane's effect column on its row, and on a row where every lane is panning — the opening row of most files — the pan moves to that lane's next free row rather than the tempo being lost.

### 9.4 Pitch, length, tempo and global volume

**Pitch** is an unsigned byte about a centre of 100, one semitone either way, and it is followed with fine pitch slides exactly as §8.6 describes. The pitches themselves are Note's, not the AdLib driver's: Note shifts the value right by two and reads a table of 25 rows a semitone, so a bend moves in 1/25 of a semitone, and its semitones are a shade wider than equal temperament. That table is the Ad Lib driver's integer recipe run at 25 steps, and it reproduces every entry of the one inside `NOTE.EXE`; middle C is anchored at concert C4 as in §8.7, and every other note keeps its distance from it on Note's table. Notes above SOP pitch 107 sound as 107, as they do in Note. In rhythm mode only the bass drum follows pitch events.

**A note's length is its own**, so a key-off is written where the length runs out. **A note that starts while the track's previous one still sounds is a slur**: Note moves the pitch and does not strike again, and the manual draws it as a feature. It is written as a fine slide on the sounding note, which lands on tick 0 as Note's does — or, for a leap of an octave or more, as the note with `G $FFFF`, which reaches it on the next tick without re-triggering. An overlapping drum hit makes no sound at all. A note that starts exactly where the last one ends is struck. 133 575 note pairs in 284 of 347 files overlap. The release itself is still the instrument's Volume Fadeout (§8.2), not anything in the pattern.

**The control track is a disjoint code space** carrying tempo and global volume. Tempo is playhead-scope, so it goes on whichever lane has its effect column free that row; it is a BPM outright, not the multiplier an `.ims` tempo event is. **Global volume** is how a SOP fades a whole song at once, and Note applies it the way it applies a track's volume: it scales every channel's 0…127 volume, which the driver then turns into total level. So it is no linear gain either, and it is not written as one — each lane's volume column carries `volume × global ÷ 127` on the curve of §8.5, and the header's global volume stays at full.

The two code spaces are disjoint in the format but not in Note's reader, which reads every code 1…8 on every track. One file outside the corpus, `MUSIC1.SOP`, has a tempo of 161 on track 0 under the control track's 157 — a reader that keeps the spaces apart refuses the whole file, and HTS plays nothing. The converter reads it as Note does and plays it as Note's player does (SOP_FORMAT §4.3): a tempo on a sequenced track is ignored, so `MUSIC1.SOP` plays at 157, and a global volume there is honoured like the control track's, the one at tick 0 joining the song header. A code outside 1…8 is still refused, because Note would read no value for it and the walk would lose its alignment.

A tempo already in force at tick 0 goes into the **song header** rather than into a cell — 325 of the 336 files set a tempo or a global volume at tick 0. Writing it as a cell as well would only fight the twenty panning commands the tracks themselves put on row 0. `basicTempo` is not the tempo: Note writes 120 into it and never reads it, and a song with no tempo at tick 0 starts at 120.

Every tempo is the one **Note's timer** actually ran: 4 × bpm interrupts a second, one tick every 240 ÷ `tickBeat` of them, with the divisor rounded down — so 120 is 120.04 — and a rate under 19 Hz left at the timer's 18.2 Hz default, so tempos 2…4 play at about 4.55 (`4OPDANCE.SOP` asks for them).

### 9.5 Everything else

- **The credits are real attribution and are kept.** §6 of the format: an instrument record of type 12 is an empty slot of the editor's 128-slot instrument box, and the scene typed the song's scrolling credits into them, 19 columns a line. They are the composer's own — unlike an `.iss` lyric file's four name fields, which hold tool defaults far more often than people — so they become the project message (`PMsg`), whole. (A deleted instrument also becomes type 12 with its name kept, so the odd line is an instrument's name rather than a credit.)
- **Instrument indices count comments too.** The index an event 6 carries is into the whole table, credits included; that reading reproduces the format's own rhythm-slot diagonal exactly (62 508 bass-drum selections on track 6, 90 036 hi-hat ones on track 10) where indexing the playable records alone does not.
- **A bad instrument index changes nothing, never a failure.** 324 selections across 7 files name an instrument past the end of the table — one asks for index 119 out of 20 — and rather more land on a credits line. In Note either one loads nothing, so the instrument already on the track keeps playing, and that is what the converter does.
- **A track that never selects an instrument gets slot 0**, Note's default. `ST-BGM.SOP` needs it: 4878 notes and not a single instrument-select event. Slot 0 holds an instrument in every file that relies on it; where it did not, the first instrument that yields a patch would stand in.
- **A track starts at volume 96**, Note's default, not the driver's 127 — 12 dB down. 254 tracks in 46 files play notes before their first volume event.
- **The hi-hat's and tom's feedback nibble is kept, and not heard.** Note writes byte 5's low four bits to those two drums' channels (they are the modulator slots), and ignores it on the snare and cymbal. In rhythm mode the chip itself gives the operators of channels 7 and 8 no modulation input at all, feedback included, so it does nothing on the hardware either.
- **Wave selects run 0…7**, not 0…3: the YMF262's four extra shapes, which the engine plays — they are the same quarter sine read differently.
- **Mixing volume is 54, not §8.7's 90.** That number puts one converted voice at exactly the level one chip voice had, which is right for an `.ims`'s eleven — a SOP has twenty, each exactly as loud, and at 90 a conversion runs a median 7.1 dB hot and clips. The player solved the same problem by measurement and backs a YMF262 off to 0.42 of full scale against a YM3812's 0.7; carrying that ratio across gives 90 × 0.42 ÷ 0.7. Measured over twenty seconds each of twelve reference files against the library's own YMF262 rendering: at 90, seven of the twelve clip and the worst loses 1.45 % of its samples to the clamp; at 54 the worst is 0.005 %. Since the instruments became OPL instruments the conversion follows the library's rendering closely enough to say so in one number: 54 is the library at a gain of 0.6, within a few tenths of a decibel, over fourteen corpus files.
- **Tuning and the whole-bars cue** are §8.7's, unchanged.
- **The "special event"** (§4.2 code 1) is passed over. It is a sync marker the manual says is for driving other programs from the music, and Note's own player ignores it. Seven occurrences in the whole corpus.

### 9.6 Version 0.2 — four tracks of recorded samples

Four `.sop` files say version **0.2**: the music of the game *개미맨*, kept in its `MUSIC.DAT` and played by the game's own sound system — written by Note's author, but not Note (SOP_FORMAT §10). The format is version 0.1 with four more tracks: `nTracks` is 24, tracks 20…23 have channel mode 3 and play on the game's sample mixer, and the instrument table gains **type 11**, a PCM record carrying its own signed 8-bit samples inline. In a version-0.1 file type 11 is still refused: its record length is in the record, so a guess would misread every record after it.

The game's player is the reference for these four files, as Note's is for the rest, and the converter follows it the way the library does (SOP_FORMAT §10.6, §10.7):

- **A WAV track is a lane, and a sample an ordinary instrument**: one-shot, no envelope, New Note Action cut, sharing the slot numbering with the OPL instruments. The signed bytes become Taud's unsigned ones by the same XOR the game applies for its Sound Blaster.
- **Note 24 plays the recording as it was made.** The instrument stores the file's rate and is detuned up three octaves, so note 24 — C1 on the grid — sounds at the recorded rate and every note keeps its own name. Pitch is equal temperament, as the library plays it; the game reads a hand-rounded period table within a fraction of a percent of it. Pitch events bend in twelfths of a semitone and stop at a semitone either way.
- **A note's length is how long its sample plays**: where the note ends the lane gets a note cut, not a key-off, because the game's note-off stops the voice and a sample has no release to play. A note that starts while the last one sounds slurs, as on the FM tracks.
- **Selecting a slot that holds no sample silences the track** until a sample is selected again — the opposite of an FM track, where a bad selection changes nothing. Every known WAV track selects FM slot 0 at tick 0.
- **Volume is linear**: `(v >> 1) + 1` of 64, onto Taud's 0…63, so 0 is quiet rather than silent. A full-scale sample is as loud as one full-level operator, which is the library's choice; on `op.sop` the converted samples alone come within 0.4 dB (RMS) of the library's rendering of the same, and every hit lands within 10 ms of it. The balance between the two is left where it is: on `op.sop` the FM runs 5.8 dB hot against the samples, so there they sit that much lower against it than the library plays them.
- **Panning is about 64.** On an FM track the game turns it into Note's three switches — below 64 is right, 64 the middle, above 64 left — and read the version-0.1 way every one of those 64s is an invalid value that silences its lane, which is how these files came out before the converter knew the version. On a WAV track it is a gradual balance, the other way round, and goes to `S $80xx` doubled.
- **Tempo is the game's clock**, not Note's: it counts the timer to the tick, so a tempo plays as written on average — 110 is 110.001 — and never faster than the game's 35 Hz interrupt.

## 10. Verifying a conversion

Some practical checks, roughly in order of how much they catch per minute spent:

- **Play it against the reference engine, not only your own.** Bit-exact agreement between engines is the format's conformance bar, and a converter bug often shows up as an engine disagreement first.
- **Check the first and last bars.** Cue HALT placement, partial final bars and loop seams all fail at the ends, where a quick listen through the middle will not notice.
- **Check a mid-song tempo or time-signature change.** Grid choice, cue breaking and `T` emission all meet there.
- **Check a note that starts bent, and a note that bends across a bar line** (MIDI), or **a slide that crosses a pattern boundary** (modules). Effect memory and recall resolution show up here.
- **Check an instrument with a keyboard split.** If Ixmp went missing — a stray `--no-project-data`, or a reader that ignores Project Data — every split instrument collapses to one sample, and it is obvious once you know to listen for it.
- **Check the loudest passage.** Pool overflow resampling, mixing-volume headroom and clipping all surface at peak polyphony.
