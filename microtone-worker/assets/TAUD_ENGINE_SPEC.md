# Taud Engine Specification

This document defines the **Taud playback engine**: how a conforming implementation turns the structures of a Taud file into audio. It covers timing, pitch, the trigger path, envelopes, the sampler, filters, mixing, the spatial model and the output stage. It does **not** define the file layout (see the **Taud File Format Specification**) or the effect column (see the **Note Effects** reference); it defines everything those two documents assume.

Taud is a ScreamTracker 3-lineage tracker extended with 16-bit effect arguments and a 4096 tone-equal-temperament pitch grid. Where behaviour has an ancestor, this document names it — ImpulseTracker (via Schism Tracker's mixer), FastTracker 2 (via MilkyTracker), ProTracker, SoundFont 2 (via FluidSynth). Those lineages are the *reason* for many rules that would otherwise look arbitrary, and an implementation that follows the rule but not the lineage will drift on real songs.

## Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY** and **OPTIONAL** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold. Lowercase uses carry their ordinary English meaning.

Arithmetic notation: `⌊x⌋` truncates toward zero, `round(x)` is round-half-away-from-zero, `x >> n` is an arithmetic right shift on a 32-bit signed integer, and `clamp(x, lo, hi)` saturates. Unless a rule says otherwise, intermediate arithmetic is IEEE 754 **binary64**; the two places where binary32 is mandatory are called out in [§12](#12-output-stage).

## 1. Model

### 1.1 Playheads

A Taud device exposes four independent **playheads**. Each owns a complete tracker state — cue position, row, tick, channel voices, background voices — and renders its own stereo stream. Synchronisation between playheads is **not** guaranteed: a song **MUST NOT** be split across playheads.

Each playhead carries the transport-scope values a song table supplies: BPM, tick rate, global volume, mixing volume, master volume, master pan, tuning, global behaviour flags and surround model.

### 1.2 Channels and voices

A song has 32 channels, or 64 when the file's `xHDR` section selects 64-channel mode. Each channel owns exactly one **foreground voice**, which is monophonic: a chord needs several channels.

Beyond the foreground voices, each playhead keeps a mixer-private pool of **background voices**, at most 64. Two things put a voice there:

- **NNA ghosts.** When a fresh note displaces a still-sounding voice, the old voice is copied into the pool and keeps ringing under the instrument's New Note Action.
- **Metainstrument layer children.** A Metainstrument trigger sounds its first matching layer on the foreground voice and every further layer as a background voice bound to that channel.

When the pool overflows, the implementation **MUST** evict the **oldest non-layer ghost**; only if every entry is a layer child does it evict the outright oldest. Layer children are protected because dropping one silences part of a chord that is still being played, whereas dropping a ghost only shortens a tail.

Background voices are not addressable from the pattern. They receive no row events; they run envelopes, fadeout, auto-vibrato and filters, and layer children additionally re-synchronise to their parent every tick ([§5.5](#5-5-metainstruments)).

### 1.3 Output

The engine renders **8-bit unsigned, stereo, interleaved** at **32 000 Hz**, which is the TSVM Audio Adapter's hardware rate and the **reference rate this document is written against**: every sample count quoted below (samples per tick, the 256-sample ramp-out, the 64-sample volume ramp, the 21-sample attack ramp) and every filter coefficient follows from it. The 8-bit dithered character is intentional and part of the format's sound; always stereo is not negotiable.

A host whose output is at another rate **MAY** run the engine at that rate instead of resampling after the output stage — the browser implementation renders 48 kHz for exactly this reason, since resampling a 32 kHz render up to the audio device's rate is a quality loss taken on every song. An implementation that does so **MUST** derive all of the following from its own rate rather than carrying the 32 kHz numbers over:

| Quantity | Rule |
|---|---|
| `samples_per_tick` ([§2.1](#2-1-ticks-and-rows)) | `rate × 2.5 ÷ bpm` |
| Playback rate ([§3.2](#3-2-playback-rate)) | `sampling_rate ÷ rate` |
| Ramp-out on sample end/cut ([§12](#12-output-stage)) | 8 ms — 256 samples at 32 kHz |
| Volume-change ramp ([§12](#12-output-stage)) | 2 ms — 64 samples at 32 kHz |
| Attack ramp-in on fresh trigger ([§8.6](#8-7-the-attack-ramp)) | ~⅔ ms — 21 samples at 32 kHz |
| Pitch glide ([§8.7](#8-8-the-pitch-glide)) | One tick, shortened by the interval; floor is the attack ramp |
| Voice filter coefficients ([§9](#9-filters)) | `rate` in §9's formulae is the running rate, so the cutoff clamp rises with it |
| Amiga LPF / LED coefficients ([§10.4](#10-4-the-post-mix-amiga-chain)) | Recomputed at the running rate, so both corners stay at their analogue frequencies (4420.971 Hz, 3090.533 Hz) |

Rate is the one thing that is an implementation's own choice. Nothing else in this document is: a render at another rate **MUST** still reach the same row at the same moment, and the same voice at the same pitch, as the 32 kHz reference — which is what makes conformance testable against a 32 kHz oracle by running the implementation at 32 kHz.

Internally the mix bus is floating point, it passes through the song's mastering chain, and the quantisation to 8 bits happens once per chunk in a defined, deterministic way ([§12](#12-output-stage)).

## 2. Time base

### 2.1 Ticks and rows

Two independent knobs set the timing, exactly as in every ScreamTracker descendant:

- **Tempo** (effect `T`, song table byte 7/8) sets the duration of one **tick**, conventionally written as BPM.
- **Speed** (effect `A`, song table byte 8) sets how many ticks make one **row** — the *tick rate*.

The tick duration is

```
tick_seconds     = 2.5 / bpm
samples_per_tick = rate × 2.5 / bpm
```

so BPM 125 gives a 50 Hz tick and, at speed 6, a 120 ms row. BPM is a 9-bit value, 25…535; the engine **MUST** clamp to that range.

Timing is accumulated **per output sample**, not per block: the engine adds 1 to a sample counter for every frame it emits, and fires a tick whenever the counter reaches `samples_per_tick`, subtracting rather than resetting so fractional remainders carry. `samples_per_tick` **MUST** be recomputed every frame, because `T` and the tempo slide can change BPM in the middle of a row. Block size is therefore not observable in the output, and an implementation **MAY** choose any block length.

### 2.2 Order of events

Per emitted frame:

1. Advance the sample counter. If it has not reached `samples_per_tick`, skip to step 5.
2. Subtract `samples_per_tick` and run the **tick pass** ([§6](#6-the-tick-pass)) for the current `tickInRow`.
3. Increment `tickInRow`. If it is still below `tick_rate + fine_pattern_delay_extra`, skip to step 5.
4. Reset `tickInRow` to 0 and **advance the row** — resolve pending jumps and pattern delays, then run the **row pass** ([§5](#5-the-row-pass)) for the new row.
5. Mix every active voice into this frame ([§10](#10-mixing)).

The consequence worth internalising: a row's events fire at the boundary that *ends* the previous row, and the row's own tick passes then run with `tickInRow` = 0…`tick_rate − 1`. Effects that act "on tick 0" therefore act on the first tick pass after their row's events, and effects that act "on ticks after the first" skip that pass.

At the very start of playback the engine runs one row pass before any frames, so row 0 sounds from the first sample.

### 2.3 Row advance

On advancing a row, in order:

1. If a **pattern delay** (`S $Ex`) is outstanding, decrement it and re-run the *same* row's row pass. Notes do not re-trigger across repetitions, but every tick-0 event does.
2. Otherwise, consume the pending jump state latched during the row:
   - A pending **order jump** (`B`) sets the cue position, sets the row to any pending row jump or 0, and resets per-pattern loop state.
   - A pending **local row jump** (`S $Bx` pattern loop) rewinds the row within the current cue, leaving the cue position alone.
   - A pending **row jump** (`C` pattern break) advances the cue, then sets the row, and resets per-pattern loop state.
3. Otherwise increment the row. If the row reaches the cue's effective row limit — 64, or fewer under a LEN or HALT-AT instruction — reset to row 0 and advance the cue.

Advancing the cue reads the cue's flow instruction: BAK moves back, FWD moves forward, JMP goes to an absolute cue, and anything else moves to the next cue. A cue carrying HALT or HALT-AT stops playback instead.

Per-pattern loop state — the `S $Bx` loop counters and the Pattern-Ditto arm state — is cleared on every cue advance.

## 3. Pitch

### 3.1 The 4096-TET grid

A note word is an unsigned 16-bit value on a grid of **4096 steps per octave**. `$5000` is C4 (middle C) and each `$1000` is an octave, so `$1000` is C0 and `$F000` is C14. Values `$0000`…`$001F` are sentinels ([§5.2](#5-2-note-events)); the playable range is `$0020`…`$FFFF`, and the engine **MUST** clamp every computed pitch into it.

One 12-TET semitone is `4096 ÷ 12` ≈ 341.33 units, and one cent is `4096 ÷ 1200` ≈ 3.41 units. Note words are not required to land on any particular grid — that is the entire point of the format — so an engine **MUST NOT** quantise them except where a command says so (glissando, `S $1x`).

### 3.2 Playback rate

A sounding voice reads its sample at

```
playback_rate = (sampling_rate ÷ rate)
              × 2 ^ ((note − $5000 + detune) ÷ 4096)
              × tuning_ratio
```

where `sampling_rate` and `detune` come from the voice's **active sample** — the base instrument record, or the Ixmp patch this trigger resolved to ([§5.4](#5-4-patch-resolution)). `note` is the final per-tick pitch after slides, arpeggio, vibrato and the pitch envelope.

Because that pitch is a per-*tick* quantity and the sample position advances per *sample*, the rate computed here is a **target**: what the sampler actually steps by glides toward it ([§8.7](#8-8-the-pitch-glide)).

### 3.3 Song tuning

The song table declares "note *N* sounds at *F* Hz". The engine folds that pair into a single whole-song frequency multiplier:

```
tuning_ratio = (F ÷ 2 ^ ((N − $5000) ÷ 4096)) ÷ 261.6255653005986
```

with the reference denominator being 12-TET concert C4. Either field reading zero means the tracker default, C9 (`$A000`) at 8363.0 Hz, which yields ≈ 0.99892 — about 1.87 cents flat, which is what an Amiga actually does.

Two implementation requirements:

- A concert declaration (A4 @ 440 Hz) **MUST** return exactly 1.0, so that concert-tuned songs render as though tuning did not exist. This falls out naturally because 440 is representable and `440 ÷ 2^0.75` is bit-identical to the reference constant.
- The ratio **SHOULD** be computed as a pure power-of-two expression with no logarithm round trip. `2 ^ (rational)` is the one transcendental that agrees bit-for-bit across platforms in practice; routing tuning through a logarithm puts cross-implementation agreement at the mercy of a last-ulp difference.

Changing the tuning takes effect on the next tick for notes already sounding, so dialling a tuning during playback bends the song in place.

### 3.4 Tone modes

The global behaviour flags select how the coarse pitch-slide effects (`E`, `F`) and tone portamento (`G`) interpret their arguments. Every mode ultimately produces a 4096-TET note word; they differ in the space the slide steps through.

| Mode | Name | Slide space |
|---|---|---|
| 0 | Linear | The argument is added directly to the note word, in 4096-TET units per tick |
| 1 | Amiga period | The argument is subtracted from an Amiga period, per tick |
| 2 | Linear frequency | The argument is added to a frequency in Hz, per tick |

**Amiga period mode** keeps a per-voice period, seeded from the note when needed:

```
period = 428 × 2 ^ (−(note − $5000) ÷ 4096)
period ← max(period − argument, 1)
note   = round($5000 + 4096 × log2(428 ÷ period))
```

428 is the ProTracker period of C4 for a standard 8363 Hz sample on the NTSC clock. Fine slides use the same expression without persisting the period.

**Linear-frequency mode** keeps a per-voice frequency:

```
freq = 261.6255653005986 × 2 ^ ((note − $5000) ÷ 4096)
freq ← max(freq + argument, 1)
note = round($5000 + 4096 × log2(freq ÷ 261.6255653005986))
```

This mode exists for sources whose slides are literally in Hz per tick — Monotone's PC-speaker arithmetic is the motivating case.

**Tone portamento** works in linear note space in modes 0 **and** 1, and in Hz in mode 2. Amiga-mode songs therefore glide linearly in pitch even though their `E`/`F` slides step in period space; this matches the Taud command reference and is deliberate.

Whenever a portamento or a mode-crossing event changes the note word, the engine **MUST** invalidate the cached period and frequency so the next slide reseeds from the new note.

## 4. Instruments

An instrument is a sample plus envelopes, filter defaults, tuning, panning rules and note-life rules. The byte layout is in the File Format Specification; this section defines what the engine does with it.

### 4.1 The active view

At trigger time the engine takes two snapshots onto the voice, and **all later playback reads the snapshots, never the instrument record**:

- The **active sample view** — pointer, length, play start, loop start, loop end, sampling rate, detune, loop mode, the five auto-vibrato fields, and the channel count/mode/second-channel pointer of a stereo pair.
- The **active envelope view** — the volume, pan, pitch and filter envelopes with their LOOP and SUSTAIN words, plus fadeout step, filter mode, default cutoff, default resonance and initial-attenuation gain.

This indirection is what makes Ixmp patches work at all, and it is also why an NNA ghost keeps playing the patch it was sounding even after the channel has moved to another instrument. An implementation that reads the instrument record during playback will get patched instruments audibly wrong.

### 4.2 Envelope roles

The record carries two pitch-or-filter envelope slots, each self-describing via the `m` bit in its LOOP word. The engine resolves them into two named roles:

1. Start with both roles unassigned.
2. For each base slot in order, if its LOOP word's `P` bit is set, assign it to the *pitch* or *filter* role its `m` bit names. A later slot claiming a role already taken overwrites it — a record whose two slots claim the same role is invalid.
3. A patch's `P` block overrides the pitch role and its `f` block overrides the filter role, each independently. The role the patch does not carry falls through to the base record.

Volume and pan envelopes resolve the same way, patch first.

This is how a SoundFont instrument — whose single modulation envelope drives pitch and filter cutoff simultaneously — and an IT instrument — which has exactly one such envelope, either pitch or filter — coexist in one record shape.

### 4.3 Instrument-scope scalars

| Field | Effect |
|---|---|
| Instrument global volume | A continuous multiplier on every output sample of the voice. Orthogonal to the volume column and to `Mxx`/`Nxx` |
| Default note volume | Seeds the per-note volume axis at trigger, unless the row carries a volume-column SET. A stored 0 means "not present" and falls back to 63 |
| Initial attenuation | A velocity-independent amplitude multiplier from the decibel octet table. Deliberately **not** folded into the envelope, so the envelope keeps its full 0…63 resolution |
| Volume swing / pan swing | A random bias drawn **once per trigger**: `⌊random × (2·swing + 1)⌋ − swing`. Volume swing scales output by `1 + bias ÷ 255`; pan swing adds `bias` to the pan sum |
| Default pan | Applied at trigger to the NOTE-pan axis, but only when the row carried an instrument byte **and** either the pan envelope's LOOP word has the `p` bit set or the resolved patch supplies its own pan ([§5.3.1](#5-3-1-the-default-position)) |
| Pitch-pan centre / separation | Also trigger-time, also only with an instrument byte: `pan_shift = ⌊((note − centre) ÷ 4096) × separation × 4⌋`, applied as a slide on the note-pan axis. It ACCUMULATES across notes on an instrument that brings no default pan of its own, which is IT's arithmetic |
| Percussion flag | Purely advisory to editors: a retuner or transposer **MUST NOT** move this instrument's notes. The engine ignores it |

## 5. The row pass

The row pass runs once per row, per channel, in ascending channel order.

### 5.1 Per-row reset

Before interpreting the cell, the engine clears the state that is scoped to one row: the note-delay and note-cut schedules, the slide arming, arpeggio, tremor, vibrato/tremolo/panbrello activation, retrigger arming, tempo- and global-volume-slide arming, the volume- and pan-column slides, and the spatial slide. It then rebases the row volume onto the persistent note volume, and records the row's effect and argument for the columns to consult.

Everything else — note volume, channel volume, pan, envelope positions, LFO phases, effect memories — persists across rows and across patterns. That persistence is what tracker composers rely on.

### 5.2 Note events

| Note word | Action |
|---|---|
| `$0000` | No note event; see the special cases below |
| `$0001` | **Key off** — set the key-off state, and apply key lift if the instrument asks for it |
| `$0002` | **Note cut** — deactivate the voice at once, and cut its layer children |
| `$0003` | **Note fade** — begin the fadeout without releasing sustain |
| `$0004` | **Fast fade** — begin a ≈ 0.3 s fadeout (below) |
| `$0005`…`$000F` | Reserved; no handler |
| `$0010`…`$001F` | **Interrupt** *n* — latch bit *n* of the pending-interrupt mask; no sound |
| `$0020`…`$FFFF` | A pitch — trigger, or retarget a portamento |

**Fast fade** exists to reproduce SoundFont *exclusiveClass* choking (a closed hi-hat silencing a ringing open one). It sets note-fading and overrides the voice's fadeout step so the decay completes in ≈ 0.3 s regardless of the instrument's own fadeout:

```
ticks = max(0.3 × bpm × 0.4, 1)
fadeout_step = clamp(round(1024 ÷ ticks), 1, $FFF)
```

Two cases of note word `$0000` are **not** silent, and both matter:

- **Instrument byte plus a pitch effect** (`E`, `F` or `G`) on a channel that already has a pitch: this **triggers** the note at the voice's current pitch, so the slide has something to move. Latching the instrument and staying silent — the obvious reading — loses the note.
- **Instrument byte alone**: latch the instrument, re-resolve its patch and re-seed the note volume from its default note volume, clear key-off and note-fading and reset the fadeout — **without** retriggering the sample. ProTracker, FT2, IT and Schism all behave this way.

A pitch on a row carrying `G` (or `L`, which also takes a target) sets the portamento target instead of retriggering. If such a row also carries an instrument byte, the instrument is latched with the same no-retrigger path **and the note is re-attacked**: the four envelope playheads go back to node 0 exactly as they would on a fresh trigger ([§5.3](#5-3-trigger-sequence)) — envelope carry included, so an envelope carrying its `c` bit keeps its playhead here too ([§5.3.2](#5-3-2-envelope-carry)) — and the smoothed volume-envelope value is snapped so the attack lands there immediately. Only the sample position stays where it is.

ImpulseTracker does not do this: with Compatible Gxx off, an instrument number next to a tone portamento never reaches its envelope reset at all, so the envelopes run on whether or not the instrument asked them to. That is a bug in IT, not a rule (its own source calls the surrounding conditions "a total mess"), and an engine **MUST NOT** reproduce it — the `c` bit is how a file says the same thing on purpose. A converter reading such a file should drop the redundant instrument byte instead; see TAUD_CONVERSION_NOTES.md.

That re-attack is what makes such a row audible at all once the previous note has been released. Clearing key-off without rewinding the envelope re-arms a sustain onto a playhead already sitting in its release tail, and the tail then holds the new note down at whatever level the release had reached — the row appears not to trigger, while starting playback from the row before it, where there is no sounding voice for the portamento to attach to, plays it correctly. FastTracker runs its whole `retrigEnvelopeVibrato` here, and all three of its parts (playheads, sustain, fadeout) are required.

A note-less instrument byte does **not** re-attack. It is the same latch without the rewind, so a released note carries on releasing.

### 5.3 Trigger sequence

A fresh foreground trigger runs three steps, in this order:

1. **Duplicate Check** ([§5.6](#5-6-duplicate-check)).
2. **NNA spawn** — migrate the existing voice into the background pool ([§5.7](#5-7-new-note-actions)).
3. **Trigger** — resolve layers and patches, then start the note.

The order matters: when Duplicate Check flags the foreground voice, the ghost that step 2 spawns inherits the flagged state.

Triggering a note **MUST**:

- Cancel any running portamento target.
- Resolve the Ixmp patch and take both active views ([§4.1](#4-1-the-active-view)).
- Set the sample position to the active play start and the direction to forward.
- Reset the volume and pan envelope playheads to node 0 and snap the per-sample smoothed envelope value, so an attack lands on node 0 immediately rather than gliding into it — **unless that envelope carries** ([§5.3.2](#5-3-2-envelope-carry)).
- Seed the pitch and filter envelope playheads past any leading zero-duration nodes ([§7.3](#7-3-the-pitch-and-filter-walker)), again unless that envelope carries.
- Reset the fadeout multiplier to 1, cancel any sample-end ramp, arm the attack ramp ([§8.6](#8-7-the-attack-ramp)), reset auto-vibrato phase and its sweep counter, and reset the NES DPCM counter and the stereo channel's DSP history.
- Draw fresh volume- and pan-swing biases.
- Apply the instrument's default position and pitch-pan separation, if the row carried an instrument byte ([§5.3.1](#5-3-1-the-default-position)).
- Reset the filter to the active defaults and clear its delay lines.
- Seed the note volume: from the volume column's SET if present, otherwise from the instrument's default note volume if the row carried an instrument byte, otherwise leave it — a note-only retrigger inherits the channel's current note volume.
- Clear the per-note overrides (`S $73`…`S $7E` NNA and envelope toggles).
- Reset the vibrato, tremolo and panbrello LFO phases if their respective retrigger flags are set.

Channel volume is **not** reset by a trigger. It belongs to the channel, not the note.

#### 5.3.1 The default position

A trigger takes its default position from one of two places, and either is enough to make it apply:

- **The resolved patch's `default pan`**, whenever that is not the `$FF` sentinel. A patch override needs no further permission — see below.
- **The base record**, but only when the pan envelope's LOOP word carries the `p` bit ("use default pan").

Whichever applies, it is written to the **note-pan axis** — an offset from the channel's own direction, not a channel position (TAUD_NOTE_EFFECTS.md §3a). An instrument never writes `channel_pan`, exactly as it never writes `channel_vol`: the channel says where the part sits, the instrument says where the note sits within it. With the channel at its `$80` / front default the two coincide, which is why a file that predates the split sounds unchanged; once the pattern has moved the channel with `S $80xx`, `P`, `X` or `Z`, the instrument's whole arrangement rotates with it instead of collapsing onto the commanded point.

The two sources are mutually **exclusive** — they are the same statement at two levels of specificity, so when both are available the patch wins and the base record's fields do not also apply. What the winner means depends on the song's surround model:

- **Stereo** — a pan byte: the instrument's record 177, or the patch's. Unchanged from the days before the spatial fields existed.
- **Planar or spatial** — the instrument's default **position**: a 9-bit azimuth whose low byte is that same byte 177 and whose ninth bit is record byte 14's `A` flag, plus the signed elevation in record byte 254. A planar song forces the elevation to zero.

A patch overrides the azimuth only, and only within the front arc: a patch record holds an 8-bit pan and no elevation and no ninth bit, so the instrument's height stands whichever pan wins. The pan ENVELOPE offsets the azimuth on top of both axes and leaves the elevation where it is.

**Why `p` does not gate the patch.** The `p` bit lives in the base record's pan envelope, and a patch may replace that envelope wholesale — its own `p` block carries its own LOOP word. Gating the patch's pan on `p` would therefore let a patch silently disable its own override, and would leave every SoundFont-derived bank centred: those base records carry no pan envelope at all, so `p` is clear, while the per-zone pan sits in each patch's byte 24. The patch's `$FF` sentinel *is* its enable flag.

Because the ninth bit and the elevation live in bits that were previously unused and are read only in a surround song, a file written before they existed keeps its exact stereo behaviour, and its default pan lands on the front arc — which is what a pan byte has always meant.

#### 5.3.2 Envelope carry

Each envelope's LOOP word carries a `c` bit (bit 6, TAUD_FILE_FORMAT §7.2). When it is set, a trigger **MUST NOT** rewind that envelope's playhead: the envelope continues from wherever the previous note on that voice left it, index and time fraction both. Carry is decided **per envelope**, from that envelope's own LOOP word, so an instrument may carry its pan sweep across a phrase while every note re-attacks its volume.

Carry applies only where there is a playhead worth keeping. A trigger **MUST** rewind regardless of the bit when any of these holds, read from the voice's state *before* the trigger touches it:

- the voice was not sounding — there is no previous note;
- the note had been released (key-off, or a Note-Fade in progress) — the playhead is somewhere down a release, and carrying it would start the new note part way through its own decay;
- the trigger changes the instrument — the playhead belongs to a different envelope.

The rule is the same wherever a playhead is rewound, which includes the re-attack an instrument byte performs on a tone-portamento row ([§5.4](#5-4-patch-resolution) and the note-event table in [§5.2](#5-2-note-events)): a chain of notes tied by `G`, each naming its instrument, sounds under carry exactly like the same chain written without instrument bytes.

A carried envelope keeps its current *value* too — the walker re-reads it from the active envelope later in the same tick, so a patch swap under a carry costs nothing and steps no gain.

### 5.4 Patch resolution

If the instrument carries Ixmp patches, the engine walks the list **in order** and takes the **first** patch whose pitch × volume rectangle contains the trigger. When nothing matches, the base record's fields are used unchanged. Because the first match wins, patch order is significant and a fully covered patch is dead weight.

The volume axis used for the lookup is the *pre-patch* seed: the volume column's SET if present; otherwise the instrument's default note volume if the row carried an instrument byte; otherwise the voice's current note volume. Using the post-patch volume would make the lookup depend on its own result.

**That axis is six bits in every format version.** The rectangle is instrument data, and a bank is format-neutral, so a version 3 engine **MUST** narrow its eight-bit note volume onto 0…63 (a shift right by two) before testing it — at *every* lookup, not only at the trigger. A version 3 engine that forgets on one path finds no patch there at all, since the seed a wide cell starts from is 255 and every rectangle written by an IT, XM or SoundFont converter ends at 63. The same narrowing applies to a Metainstrument's layer rectangles, which share the axis.

A patch's "no override" sentinels — default pan `$FF`, default note volume 0, auto-vibrato waveform `$FF` — defer to the base record field by field, with one exception the format forces. **The auto-vibrato sentinel governs all five of its fields.** There is one sentinel for speed, sweep, depth, rate and waveform, so a patch carrying `$FF` *and four zeroes* is saying nothing about auto-vibrato at all and the base record's whole block applies; reading those zeroes would switch an instrument's own vibrato off on every note its keyboard map covers. A patch whose waveform is `$FF` but which states any non-zero number is stating its own vibrato and borrows only the waveform; a patch that names a waveform overrides the block outright, zeroes included.

### 5.5 Metainstruments

A **Metainstrument** is an instrument whose record names other instruments instead of holding a sample ([File Format §7.4](TAUD_FILE_FORMAT.md#7-4-metainstrument-records)). The name is the **family**; the record's type nibble says which **kind**, and the two kinds sound their table in opposite ways:

| Type | Kind | What the engine does with the table |
|---|---|---|
| 0 | **Layered** | sounds every entry whose rectangle contains the trigger, **in parallel** — one voice each. This section. |
| 4 | **FM Rack** | reads the entries as **operators** and the words after them as an algorithm: **one voice**, whatever that algorithm produces. [§5.5.1](#5-5-1-type-4-fm-racks). |

A type the engine does not know **MUST** sound nothing rather than fall back to type 0.

#### Type 0 — Layered

The rules below are written for the Layered kind, where they are easiest to state, but not all of them stop there: [§5.5.1](#5-5-1-type-4-fm-racks) says which a rack inherits **unchanged** — the release of the previous note, the per-tick sync of a child to its parent, and the pattern's reach over every voice sounding one note — and which are the Layered kind's own, the soundfield below being the plainest of them.

If the trigger's instrument is a Layered Metainstrument, the engine first **releases** the channel's existing layer children: each is detached from the parent and given its own instrument's New Note Action (note off with key lift, cut, continue, or fade).

Then it collects every layer whose rectangle contains the trigger, in record order. Under **strict layering** it additionally drops any layer whose own instrument resolves no patch at the (detuned) trigger. If nothing survives, the channel goes **silent** for this note — that is the correct outcome, not a fallback.

Otherwise the first surviving layer sounds on the foreground voice and every further layer spawns a background voice bound to this channel. Each child inherits the parent's channel volume and channel pan (azimuth and elevation included) **as they stood before the foreground layer retriggered**, carries the parent's *relative* detune, and takes its own mix gain from the decibel octet table.

**A layer may be NON-MELODIC.** With the fixed-pitch flag set ([File Format §7.4](TAUD_FILE_FORMAT.md#7-4-metainstrument-records)) a layer sounds one pitch whatever key was struck, and its detune field is that pitch — an absolute unsigned note word rather than an offset. Three consequences, and the third is the one an implementation gets wrong:

- the pitch the layer triggers at is its own field, clamped to `$0020`…`$FFFF`, and the layer instrument's patch resolution ([§5.4](#5-4-patch-resolution)) is done at that pitch, not the trigger's;
- the **gating rectangle is unaffected** — it still asks about the trigger, so a fixed-pitch layer covers the keys its rectangle covers and simply plays its own note within them;
- the *relative* detune a child carries is the difference between the two layers' **sounding notes**, not between their detune fields, which is what keeps the arrangement intact when layer 0 is the fixed one. Where neither layer is fixed the two are identical, so nothing about an existing file changes.

A fixed-pitch child then does **not** track the parent's note in the per-tick sync below: it holds the note it was triggered at for the whole note. Everything else in that sync still reaches it — key-off, fading, the volumes, both pan axes, and the pattern's **pitch overlay**, so a vibrato written on the channel still bends it. What the flag takes away is the keyed note, not the pattern's reach over the note.

**A Layered metainstrument is a soundfield, and layer 0 is where it sits.** A layer's own default position ([§5.3.1](#5-3-1-the-default-position)) is not kept as an absolute place but as a **relative** one: the engine records how far the layer sits from layer 0's own position and holds that distance for the whole note. This is the pan twin of the relative detune beside it, and it has the same consequence — a note-pan SET, or anything else that moves the meta, **rotates** the whole arrangement instead of collapsing it onto one point. A layer that declares no position of its own has no opinion about where it sits relative to the centre, so its offset is zero and it simply rides wherever the meta goes.

The order matters: the child inherits that channel context *before* it is triggered, so its own trigger can still move it to its own default position ([§5.3.1](#5-3-1-the-default-position)). Inheriting the parent's pan afterwards would flatten every layer onto the first one's position — audible as a SoundFont kit whose layers are meant to pan apart collapsing to a point.

Every tick thereafter, a layer child re-synchronises to its parent: pitch (parent note plus relative detune **plus the parent's pitch overlay for this tick**), key-off, note-fading, channel volume, note volume, row volume, channel pan (azimuth and elevation included), and note pan **plus its own relative offset**. The two relative quantities are handled identically, and for the same reason: the pattern stays in command of the meta as a whole — a panning column or an `S $80xx` written on its channel reaches every layer — while the arrangement the instrument describes survives inside it. When the parent goes inactive the child detaches — but if the parent was *released* and its own fadeout deactivated it within the same tick, the child **MUST** inherit that release before detaching, or a chord's upper layers will ring on after the note that released them.

**Anything the pattern says about the note, it says about all of it.** This one is the family's, not the kind's — it governs a rack's operator voices exactly as it governs a stack's layers. The pitch overlay is the general case of a rule that runs through the whole effect column: a metainstrument is ONE note, so a command written on its channel **MUST** reach every voice sounding it, never layer 0 alone. The overlay itself is what the row's effects did to the pitch *this tick* — vibrato, glissando and arpeggio — carried as a signed delta on top of the note the child already tracks; auto-vibrato and the pitch envelope stay out of it, because those are the instrument's own and each layer runs its own copy. A child that has detached drops the overlay, so it finishes at its own note rather than frozen mid-bend. The same rule governs the bitcrusher and overdrive ([TAUD_NOTE_EFFECTS.md §8/§9](TAUD_NOTE_EFFECTS.md)), the sample-modification command (§2/§3), Q's retrigger, the filter overrides (§5/§6) and the envelope gates (`S $7x`).

Layer indices are 10 bits, so layers **MAY** live in the auxiliary instrument bin, which a pattern cell cannot reach. A layer index pointing at another Metainstrument, or at instrument 0, is skipped. Both rules belong to the family, not to this kind: a rack's operator indices are read the same way.

#### 5.5.1 Type 4 — FM racks

A **type-4** Metainstrument is an **FM Rack** ([File Format §7.6](TAUD_FILE_FORMAT.md)). It reads the same table as an *operator rack* and carries an RPN algorithm saying how its operators feed each other. Everything above turns on layers being **parallel**; a rack is the other arrangement, and the difference shows up in one sentence: **a rack is one voice, not one per entry.** Its operators are operands, and only the algorithm's result is a sound.

An operator's **oscillator is an ordinary instrument** — sample, loop, envelopes, filter, auto-vibrato and all. That is what this is for. A single-cycle looped waveform gives textbook FM; anything longer gives something a chip could not.

**Triggering.** The engine collects the operators the algorithm names by a `$00xx` or `$04xx` word AND whose rectangle contains the trigger, gating them on the same narrowed six-bit volume axis as a layer's. Operator 0 sounds on the channel's foreground voice, at the note plus its own detune; each other surviving operator takes a voice of its own, bound to the channel exactly as a layer child is and carrying the same *relative* detune — so the per-tick sync of [§5.5](#5-5-metainstruments), `Q`'s whole-instrument retrigger, and the release of the previous note all apply unchanged. If the algorithm does not verify, or operator 0 does not survive, the channel goes **silent**.

An operator voice is **not** a layer child in two respects. It carries no position of its own: a rack is one signal, sitting where the channel sits, so an operator's own default pan is not read and nothing pulls the rack sideways. And it is never mixed: the mixer **MUST** skip it, because the rack that owns it already read it.

**Reading an operator.** Each sounding operator is evaluated **at most once per output sample**, in the order the algorithm reaches it, through the ordinary sampler ([§8](#8-the-sampler)) — loops, interpolation, invert loop, funk repeat and the sample modifications included. Its value is that sample times its own mix gain and, for every operator except 0, its own volume envelope, fadeout, instrument global volume, initial attenuation and anti-click ramps, with its own filter applied. That list is exhaustive, and what it leaves out is the point: the note and channel volume are **NOT** applied to an operator. A rack is one voice, the mixer applies those to the finished patch through operator 0, and an operator's level is a modulation INDEX — applying the volume column to a modulator as well would make a patch played quietly also play duller. **Operator 0's envelope, fadeout, instrument global volume, filter and voice effects are applied by the mixer to the finished patch instead** — it is the channel's own voice, and that is what makes it the principal: its envelope is the note's shape and its sample ending is the note's end.

**Phase modulation.** A `$04xx` word pops a value *m* and reads its operator at

```
read_position = position + m × cycle
```

where `cycle` is the operator's **loop length** when it loops, and its whole sample length when it does not. The read position is folded back into the loop (or clamped, for a one-shot); the voice's own trajectory is untouched, so the carrier keeps its pitch and only *where in the waveform* this one output sample is drawn from changes.

Measuring the depth in cycles is what makes the mix octet read as a modulation index in the ordinary sense: at unity the modulator sweeps the carrier ±1 whole cycle, and the octet table's +24 dB reaches ±16. A modulator is scaled by its own mix octet before it ever reaches this word, so an operator's level *is* its index when it modulates and its volume when it carries — as it is on every FM instrument ever built.

**The stack.** Words run in order, every word every sample; the value left on the stack at the end is the patch. `$08xx` pushes what its operator produced on the *previous* output sample, and every operator's tap advances together after the whole program has run — so a tap reads last sample's value wherever it sits, which is what lets a rack close a feedback loop in one pass. `$08xx` on an operator the algorithm does not sound reads 0.

**Cost.** A rack costs one voice against the channel plus one background voice per sounding operator beyond the first, and one sample fetch per sounding operator per output sample. Unlike a layered metainstrument, none of that reaches the mix as a separate source: however many operators a rack has, it is one note in one place.

**A rack does not spawn a New Note Action ghost.** A ghost is a snapshot of one voice, and a rack is a voice plus the operators that shape it; a ghost carrying only the snapshot would sound operator 0's bare sample, which is not the note that was playing and not a sound the patch can make. The incoming note takes the channel instead, and the operators go with the note that built them. Past-note actions (`S $70`…`$72`) already do not reach a metainstrument's channel, and that covers a rack for the same reason.

### 5.6 Duplicate Check

Duplicate Check (DCT/DCA) fires on every fresh foreground trigger that carries an instrument byte, **before** the NNA spawn. It does not fire on tone portamento, on key-off, on note cut, or on an empty cell.

The values consulted belong to the **existing** voice's instrument, not the incoming note's, so two instruments sharing a channel can behave asymmetrically. Targets are the channel's foreground voice and every background voice that channel spawned; each is tested independently against the incoming (instrument, note) pair.

| Type | Matches when |
|---|---|
| 0 — off | Never |
| 1 — note | Same note word **and** same instrument |
| 2 — sample | Same instrument **and** same canonical sample, matched by pointer and length |
| 3 — instrument | Same instrument |

| Action | Effect on a matching voice |
|---|---|
| 0 — note cut | Zero the fadeout multiplier; the voice deactivates this tick |
| 1 — note off | Set key-off (releasing sustain, applying key lift, and starting the fadeout if one is configured) |
| 2 — note fade | Begin fading immediately, with no sustain release, so sample and envelope loops continue |

### 5.7 New Note Actions

When a fresh note arrives on a channel whose voice is still sounding, the old voice is copied into the background pool and the copy is treated per the New Note Action — the instrument's own, unless a per-note override (`S $73`…`S $76`) is in force.

| NNA | Behaviour |
|---|---|
| 0 — Note Off | The ghost gets key-off (and key lift), releasing sustain into its release stage |
| 1 — Note Cut | No ghost is spawned at all; the voice simply stops |
| 2 — Continue | The ghost keeps playing unchanged |
| 3 — Note Fade | The ghost begins its fadeout immediately |

The ghost copy **MUST** carry the full playback state: both active views, both filter topologies' coefficients *and* delay lines, all four envelope playheads, the fadeout multiplier, the swing biases, the auto-vibrato phase, the spatial position and the stereo channel's own DSP history. A partial copy produces a click or a wrong-sounding tail at every NNA event; copying the filter but not its history is the classic instance.

Past-note actions (`S $70`…`S $72`) act on *all* background voices a channel spawned: cut removes them outright, off releases them with key lift, fade starts their fadeout.

### 5.8 Volume and panning columns

The columns are applied after the note event and before the effect column.

- **Volume SET** writes the note volume (and rebases the row volume onto it).
- **Volume slide up/down** arms a per-tick slide for ticks after the first.
- **Volume fine** applies a one-shot delta at tick 0 — bit 5 of the value is the direction, bits 0…4 the magnitude. A value of 0 is the canonical no-op.
- **Pan SET** writes the **note** pan, scaled from six bits to eight as `(v << 2) | (v >> 4)` and taken as an offset from centre. It replaces whatever the instrument seeded, so it is how a composer pans one note of a zone-panned instrument by hand. An `S $80xx` on the same row addresses the other axis and both apply.
- **Pan slides** behave like the volume slides but move the note pan, and in a surround song they **wrap** the azimuth where the stereo model clamps. They keep their own per-tick accumulator, separate from effect `P`'s, so a `P` and a column slide on one row move the two axes independently.

Both columns write the per-note axis of their quantity and neither can reach the per-channel one (TAUD_NOTE_EFFECTS.md §3, §3a); `M` / `N` and `S $80xx` / `P` / `X` / `4` / `Z` are the commands that can.

The pan column's SET keeps its front-arc meaning in every surround model — six bits cannot express a full turn, and `S $8xxx` and `X` are the commands that can.

### 5.9 Pattern Ditto

Effect `7` arms a row-time repeat region on its channel: `7 $LLRR` repeats the preceding `LL` rows `RR` times, starting from the arming row. Within the region, each row is composed from the *source* row it echoes, overlaid by whatever the destination cell actually carries — a non-zero note, a non-zero instrument, a volume or pan column that is not the FINE-0 no-op, and a non-zero effect all override the echo. An echoed `7` in the source is not re-armed.

Because the region is derived at play time from the arming row, an engine that supports starting playback mid-pattern **MUST** reconstruct the arm state by replaying the raw rows from row 0 up to the start row; otherwise ghost rows are silent when seeking into a region.

## 6. The tick pass

The tick pass runs once per tick, per voice, and is where everything continuous happens. For each foreground voice, in order:

1. **Scheduled note cut** (`S $Cx`): if this is the scheduled tick, zero the note and row volume — leaving channel volume alone — and mark the note cut.
2. **Note delay** (`S $Dx`): if this is the scheduled tick, perform the deferred event. For a pitch, that means the full trigger sequence of [§5.3](#5-3-trigger-sequence). **The instrument binding MUST be re-read afterwards** — the trigger may have swapped the voice's instrument, and the rest of this tick must see the instrument that just fired.
3. **Scheduled follow-up action** (`S $Dxny`): if this is the scheduled tick, apply note off, note cut, continue, note fade or forced key lift. Forced key lift bypasses the instrument's own key-lift flag, exactly as `S $73`…`S $76` bypass its NNA.
4. If the voice is inactive, advance its volume envelope anyway and move on — an inactive voice still needs its envelope walked so that a re-trigger or a scheduled event sees a coherent state.
5. **Pitch slides** (`E`, `F` coarse) on ticks after the first, in the current tone mode.
6. **Tone portamento** on ticks after the first: step toward the target and stop exactly on it, in note space or Hz space per the tone mode.
7. **Volume slides** — the effect-column coarse slide and the volume-column slides — on ticks after the first.
8. **Channel-volume slide** (`N`), the **pan-column slides** (note axis) and effect `P`'s slide (channel axis), on ticks after the first.
9. **Spatial slide** (`Z`) on ticks after the first ([§11.5](#11-5-the-z-slide)).
10. **Tremor** (`I`): advance the on/off phase counter; while off, force the row volume to 0.
11. **Vibrato** (`H`, `U`): `delta = (lfo × depth) >> shift`, where the shift is 6 for `H` and 8 for `U` — the finer of the two. The result overlays the note for this tick only; the underlying note word is untouched. Phase advances by `speed`, modulo 1088.
12. **Glissando** (`S $1x`): snap the *sounding* pitch to the nearest 12-TET semitone while leaving the note word smooth.
13. **Tremolo** (`R`): `row_volume = clamp(note_volume + ((lfo × depth) >> 9), 0, 63)`.
14. **Panbrello** (`Y`): `panbrello_offset = (lfo × depth) >> 7`. This is a signed offset the mixer sums with the two pan axes ([§10.3](#10-3-panning)), **not** a write to either of them — so the LFO swings around wherever the channel and the note have put the voice, without consuming the instrument's own pan seed, and the same offset steers the surround models ([§11](#11-the-spatial-model)). On a tick where `Y` is not active the same step sets it to 0, so a row without `Y` puts the voice back on its base pan. That zero **MUST** be written here and not in the row reset ([§5.1](#5-1-per-row-reset)): a row boundary runs the row pass *after* this one, so a value the row pass clears is still cleared while the new row's first tick renders — one tick of dead centre in the middle of a sweep that spans several rows.
15. **Arpeggio** (`J`): the tick index modulo 3 selects offset 0, the first argument byte or the second, each shifted left 8 bits (one argument byte is 256 units ≈ 0.75 semitones). This *overrides* the sounding pitch for the tick.
16. **Retrigger** (`Q`): count ticks and, on reaching the interval, restart the sample at the active play start, clear key-off, reset all four envelope playheads (re-seeding the pitch and filter ones past zero-duration nodes), reset the fadeout, auto-vibrato and filter history, and apply the retrigger volume modifier.
17. **Auto-vibrato** ([§6.1](#6-1-auto-vibrato)), added on top of the sounding pitch.
18. **Pitch envelope** contribution ([§7.4](#7-4-pitch-and-filter-envelope-application)).
19. Compute the final pitch, clamp it to `$0020`…`$FFFF`, and update the playback rate.
20. **Filter envelope** applied to the cutoff, then refresh the filter coefficients if cutoff or resonance changed.
21. **Fadeout**: while key-off or note-fading, subtract `fadeout_step ÷ 1024` from the fadeout multiplier, clamped at 0; at 0 the voice deactivates. A `fadeout_step` of 0 never fades.
22. **Advance the volume and pan envelopes**, then set the per-sample envelope slope for the coming tick.
23. **Advance the pitch and filter envelopes**.

Then, once per tick at playhead scope: the tempo slide, the global volume slide, the invert-loop mask advance and the funk-repeat walk. Finally the background voices run their own reduced pass — layer-child re-synchronisation, all four envelopes, fadeout, auto-vibrato, pitch and filter envelopes, coefficient refresh — and fully faded ghosts are reaped.

### 6.1 Auto-vibrato

Auto-vibrato is instrument-scope (or patch-scope) and independent of the `H` command. Its depth ramps in from zero over the note's life, in whichever of the two source conventions the instrument carries:

```
if sweep ≠ 0:   ramp = min(⌊depth × t ÷ sweep⌋, depth)     (FT2: ticks to full)
elif rate ≠ 0:  ramp = min((t × rate) >> 8, depth)          (IT: ramp acceleration)
else:           ramp = depth
```

with `t` the ticks since the trigger. The pitch delta is `(lfo × ramp × 43) >> 12`, and the phase advances by `speed` modulo 1024. Waveform 4 (ramp up, FT2 only) is the negation of waveform 1.

**Both bytes are the source tracker's field × 4.** IT's `Vis` and `Vid` and XM's rate and depth are 6-bit; the record widens them, and every number in this section is written for the widened scale. Depth 255 — the record's maximum, and IT's `Vid` 64 — is ±1 semitone, ±341 units of 4096-TET; the `× 43 >> 12` is that calibration and the response is linear below it. Speed 255 is a cycle every four ticks, speed 4 one every 256. A producer that writes the source field unscaled therefore sounds a quarter of the intended depth at a quarter of the intended rate — not a rounding difference, an audibly different instrument.

A record whose ramp fields are both zero plays at full depth from the first tick, which is FT2's reading of a zero sweep. **IT's is the opposite**: its `Vir` is the only thing that lifts the depth off zero, so an IT sample with `Vir` = 0 plays no auto-vibrato at all however deep its `Vid`. That one is a converter's job — the depth it writes is 0 — because an editor needs the FT2 reading: an instrument given a speed and a depth and nothing else has to sound.

### 6.2 The LFO

Vibrato, tremolo, panbrello and auto-vibrato share one waveform generator, but not one phase scale. The command LFOs (`H`, `U`, `R`, `Y`) run a **1088-step** phase advanced by `speed` per tick and indexed `⌊phase ÷ 17⌋`; auto-vibrato, whose rate comes from the instrument record rather than an effect byte, runs a **1024-step** phase advanced by `speed` and indexed `⌊phase ÷ 16⌋`.

`1088 = 64 × 17`, and the 17 is the same 17 that a **nibble-repeat** multiplies by — the mapping every 4-bit source field uses to reach a Taud byte. The step count is deliberately not a power of two, because carrying that factor is what makes a converted speed byte reproduce the source tracker's oscillator *exactly* instead of approximately. A tracker advances an 8-bit phase by `speed × 4` and indexes `(phase >> 2) & 63`, so at tick `t` its index is `x·t mod 64`. A converted byte `17x` advances by `17x` through 1088 and indexes `⌊phase ÷ 17⌋` = `(17·x·t mod 1088) ÷ 17` = `x·t mod 64` — the same table entry, on the same tick, indefinitely. A power-of-two 1024 would have been 17/16 = 6.25% fast.

Auto-vibrato's 1024 is the same reasoning at the other scale. A tracker advances a 256-step phase by its `Vis` and indexes `(phase >> 2) & 63`, so a record byte of `4·Vis` over 1024 steps indexes `(4·Vis·t mod 1024) >> 4` = `(Vis·t mod 256) >> 2` — the same table entry, on the same tick, indefinitely. The phase **MUST** be at least this long: a 256-step phase advanced by `speed × 2` steps a widened byte clean over the table, and every multiple of 64 then lands only on entries 0 and 32, which are both zero — silence, at the two speeds (`Vis` 16 and 32) an IT sample is most likely to carry.

An 8-bit speed byte therefore spans the same rate range as a 4-bit nibble with 17× the resolution: 1088 ticks per cycle at `$01`, 4.27 at `$FF` — and `$FF` is exactly where a source tracker's `$F` lands. Both the division and the modulo run once per voice per **tick**, never per sample, so neither costs anything worth a power-of-two compromise.

| Waveform | Value |
|---|---|
| 0 — sine | A 64-entry signed sine table, amplitude ±$7F |
| 1 — ramp down | `$7F − (index << 2)` |
| 2 — square | `+$7F` for the first half of the cycle, `−$7F` for the second |
| 3 — random | A fresh uniform byte, biased to −$80…+$7F |

Waveform 3 is genuinely random and is the reason some songs never render bit-identically twice ([§13](#13-determinism)).

## 7. Envelopes

Each envelope is 25 nodes of (value, duration). Durations are 3.5 minifloat indices; **a duration of 0 is a terminator**, not an instant transition — except in the pitch and filter walker, where it *is* an instant transition. That asymmetry is deliberate and is the single most commonly mis-ported rule in this specification.

### 7.1 Wrap resolution

Every tick, for every envelope, the active wrap region is resolved from the LOOP and SUSTAIN words and the key state:

1. SUSTAIN enabled **and** key on → wrap between sustain start and sustain end.
2. Otherwise LOOP enabled → wrap between loop start and loop end.
3. Otherwise → no wrap.

A wrap region whose start equals its end **holds** at that node (the FT2 single-point sustain). Sustain therefore takes precedence while the key is on; once the key is released the LOOP region becomes active and can capture the playhead as it walks into range.

### 7.2 The volume and pan walker

For the volume envelope — evaluated whenever the voice's volume-envelope toggle is on, regardless of any wrap bits — and the pan envelope, which additionally requires its `P` presence bit:

- If wrapping and the playhead is at the wrap end with start equal to end: hold, taking the node's value.
- If wrapping and the playhead is at the wrap end: reset the time carry, jump to the wrap start, take that node's value.
- If the playhead is at node 24: take node 24's value.
- If the current node's duration is 0: **freeze** here and take its value.
- Otherwise: accumulate the tick into the time carry; when it passes the node's duration, subtract the duration and step (to the wrap start if wrapping at the end, else to the next node, capped at 24). Between nodes, the value is linearly interpolated on the time fraction.

Volume values scale as `clamp(value ÷ 63, 0, 1)`; pan values as `value ÷ 255`.

**The cut rule.** When the volume envelope freezes at a node — either the terminator case or arrival at node 24 — *and* that node's value is 0 *and* no wrap is active, the engine **MUST** start the voice's ramp-out. Without this, instruments with a stored fadeout of 0 and an envelope ending at 0 hold their voices forever.

### 7.3 The pitch and filter walker

The pitch and filter envelopes use a different walker, and the difference is not cosmetic:

- Zero-duration nodes are **skipped**, not frozen. The walker advances past any run of them until it reaches a node with a duration, a sustain boundary, or node 24.
- Wrap handling is otherwise as in [§7.1](#7-1-wrap-resolution), with the same hold-at-a-point behaviour.
- Values scale as `value ÷ 255`, with **0.5 as unity**.

At note-on (and on a `Q` retrigger) the playhead is **seeded** by running the walker once with a zero tick, which settles it past any leading zero-duration nodes. An engine that seeds at node 0 without settling will play a SoundFont-derived attack a step behind.

### 7.4 Pitch and filter envelope application

The pitch envelope's contribution is ±16 semitones at full scale:

```
pitch_delta = ⌊(value − 0.5) × 2 × 16 × 4096 ÷ 12⌋
```

The filter envelope scales the cutoff, with 0.5 as unity at the instrument's default cutoff:

```
IT units:  base = (default_cutoff < 255)    ? default_cutoff : 254
           cutoff = clamp(⌊base × value⌋, 0, 254)
SF units:  base = (default_cutoff < $FFFF) ? default_cutoff : 13500
           cutoff = clamp(⌊base × value⌋, 0, $FFFF)
```

Background voices apply both identically — and **MUST** branch on the filter mode in the same way, or SoundFont ghosts will be filtered as though their cents were IT bytes.

### 7.5 Key lift

An instrument with the key-lift flag treats key-off as a true MIDI key release: the volume envelope playhead jumps straight to the sustain-end node, so the release nodes play at once instead of the playhead first walking the remaining pre-sustain nodes. It applies wherever key-off is delivered — the pattern key-off word, an NNA ghost's release, a Duplicate Check note-off, and past-note off. Instruments with no volume-envelope sustain region are unaffected, since there is no release boundary to jump to.

## 8. The sampler

### 8.1 Reading a sample

Sample data is unsigned 8-bit with `$80` as zero; a byte converts to `(b − 127.5) ÷ 127.5`. Reads clamp the index into the sample and clamp the pool address into the 8 MiB pool, so a malformed pointer cannot read out of bounds.

If the instrument has an active **invert-loop** mask ([§8.4](#8-4-invert-loop-and-funk-repeat)) and a non-empty loop region, a byte inside the loop whose mask bit is set is XOR-ed with `$FF` before conversion. The loop that indexes the mask is the one the instrument declares; funk repeat's walk does not move it.

A live **sample modification** ([§8.5](#8-5-sample-modifications)) may additionally move *which* byte this read takes and change its value; [§8.5](#8-5-sample-modifications) fixes the order the two features compose in.

### 8.2 Loop modes

After each output sample the position advances by the playback rate, then:

| Mode | Behaviour on reaching the end |
|---|---|
| 0 — none | Clamp to the last sample and start the ramp-out |
| 1 — forward | Subtract the loop length (at least 1) from the position |
| 2 — ping-pong | Clamp to the loop end and reverse direction |
| 3 — one-shot | As mode 0 |

While playing backwards, the position decreases; on falling below the loop start it clamps there and reverses forward again.

A **sustain loop** (loop-mode bit 2) is a loop only while the key is held: once key-off arrives, the effective loop mode becomes 0 and the voice plays out to the sample end. This is how a sustain-looped instrument releases naturally.

### 8.3 Interpolation

The interpolation mode comes from the global behaviour flags and applies to every voice.

| Mode | Algorithm |
|---|---|
| 0 — default | Windowed sinc: a Hann-windowed sinc kernel over ±3 taps, tabulated at 1024 sub-sample positions and linearly interpolated between table entries |
| 1 — none | Zero-order hold — take the sample under the integer position |
| 2 — Amiga 500 | Zero-order hold, plus a post-mix one-pole low-pass at 4420.971 Hz and the optional LED filter |
| 3 — Amiga 1200 | Zero-order hold, plus the optional LED filter only: the A1200's own one-pole sits at ~34 kHz, above Nyquist at any rate the engine runs at, and is bypassed |
| 4 — SNES | The SPC700's 4-tap Gaussian, run over the DSP's signed **15-bit** sample domain (`-$4000`…`+$3FFF`) as the hardware does. Its partial overflow handling is preserved: of the three tap additions the second is allowed to wrap and only the third saturates, so the ROM table's bugged `$801` phases still "chirp" exactly where the hardware does — a run of max-negative samples reads back as `+$3FF8`. Promoting the samples to 16 bits instead makes the mid-sum wrap on *all* content past half scale, which folds loud waveforms inside out and doubles everything else |
| 5 — NES DPCM | A 1-bit sigma-delta simulation: a 7-bit counter slews ±2 toward the target level per output sample |

The Amiga LED filter is a second-order section at 3090.533 Hz with Q = 0.660225, toggled by `S $00` / `S $01` and applied to the **stereo mix**, not per voice. It is available only in the two Amiga modes.

SNES and NES DPCM modes carry per-voice state (the DPCM counter), and a stereo voice keeps a separate counter per channel.

### 8.4 Invert loop and funk repeat

ProTracker's `EFx` is two effects that were never the same one. **Invert loop** (PT 1.1B onwards) is `S $F0xx` and grinds a progressive inversion through the loop's bytes; **funk repeat** (PT 1.0C, whose step body 1.1B threw away) is `Z $F0xx` and hops the loop itself through the sample, leaving every byte alone. They share the speed ladder — an 8-bit accumulator, a table of increments, one step whenever bit 7 of the sum is set, and a reset to zero rather than a subtraction, so the period is exact and free of jitter — and nothing else. Both are per-tick, both are non-destructive here, and both **MAY** run on one voice at once.

**Invert loop** keeps a per-instrument bit mask over the loop region. On each step it toggles the mask bit at the current write position, which advances cyclically through the loop; sample bytes whose mask bit is set read inverted. The write position resets on a fresh trigger; the speed and accumulator persist.

The loop the mask covers is the **active** one — an Ixmp patch replaces the base record's loop points, and the mask is sized and indexed against whichever loop the voice is actually sounding. The mask is instrument-scope runtime state and **MUST** be cleared on a transport reset, or a replay will start from a scrambled sample.

**Funk repeat** keeps a per-voice pointer instead. The window `[pointer, pointer + loop_length)` is the loop the voice sounds, and each step moves the pointer by a **hop**: the loop length shifted right by the low two bits of the command's walk selector, so a whole loop length, a half, a quarter or an eighth of one. The pointer lives on the grid of positions `loop_start + k × hop` the hop defines, stopping at the last `k` whose whole window still fits before the sample end, and the selector's high two bits say how it moves over that grid — forward wrapping home, backward wrapping to the top, forward with each landing thrown within an sixteenth of the grid, or a free uniform throw across all of it. `$f = 0` is ProTracker 1.0C's own walk, one whole block forward, and it is what a converted module gets; the argument encoding, the exact draws and the reasons behind them belong to the **Note Effects** reference.

The window **MUST** take effect only when the loop restarts — ProTracker wrote the pointer into Paula's repeat register and the DMA latched it at the restart, so the block already sounding always finished first, at any hop size. On a ping-pong loop the latch happens at one end only. A voice with no loop, whose loop is as long as its sample, or whose loop sits at the sample's tail has nothing to walk and is left alone whatever the selector says. The **window never changes size**: a hop is a distance, not a length, and a window resized under a sounding voice would move the pitch this command exists to hold still.

The restart that installs a moved window is a **step discontinuity** — the read jumps into material unrelated to the material just playing — and an engine **SHOULD** crossfade it exactly as it crossfades a sample modification's step ([§8.5](#8-5-sample-modifications)): read the position through both the new window and the one it replaced, mix on a weight falling on the output clock, and cap the fade at one grain (`loop_length ÷ rate` output samples) so it always completes before the restart that would re-arm it. A restart where the window did not move **MUST NOT** be faded: an ordinary loop wrap is the seam the musician chose.

The two random spellings keep a **second** pointer: the walk steps forward deterministically and the sounding pointer is a throw measured from it, re-measured from the walk on every step and never from where the last throw landed. Feeding one throw into the next builds a random walk instead, whose spread grows without bound until the narrowest rung of the ladder is the widest — the same rule, and the same reason, as the sample modifications' jumps and scatters ([§8.5](#8-5-sample-modifications)). A throw that would leave the grid is clamped, which is safe only because the walk under it keeps moving.

Both pointers and the window return to the instrument's own loop on a fresh trigger; the speed, the walk selector and the accumulator persist, as invert loop's speed does. Funk repeat's accumulator persists further still: unlike `S $F0xx`'s it is **not** cleared when the command is rewritten or switched off, which is ProTracker's own behaviour and is what makes the ladder a running phase rather than a period counter. An NNA ghost inherits the window it was displaced with — its position is inside it — but not the walk. All of it is voice-scope runtime state and **MUST** be cleared on a transport reset.

### 8.5 Sample modifications

Note effects `2 $sexy` and `3 $sexy` apply a running, non-destructive modification to part of a sample. The argument encoding, the region selectors and the operation ladder belong to the **Note Effects** reference; what the sampler owes them is the read-time contract below. `3` names the region to modify and `2` names the region to spare — the inversion is the only difference between the opcodes, and it applies to the region *and* its comb.

**State.** An instrument carries **one** modification: an operation, a region (extent plus optional comb), and whatever that operation has accumulated. Writing either opcode replaces it, and changing the operation, the region or the inversion **MUST** discard the accumulated state — a rotation offset means nothing to a subtract. Re-stating the *same* command **MUST NOT** discard anything, or a command repeated down a pattern would never get past its first step. The **clock** driving the modification is per voice, so the state is shared but the clock is not: N voices sounding one instrument step its modification N times per tick.

**The step clock** is a period in ticks: each tick the voice counts one, and on reaching `16 − $y` the count resets and the operation steps once. `$y = 0` freezes the modification without discarding it. This is deliberately *not* invert loop's accumulator ladder ([§8.4](#8-4-invert-loop-and-funk-repeat)) — that table is a divisor whose steps land where the arithmetic puts them, and the jump operations are worth little off the tick grid.

**The domain.** Everything the command measures is a fraction of one span, resolved **per sounding voice**: the active loop region when `loop_end > loop_start`, and the whole sample otherwise — the same test [§8.4](#8-4-invert-loop-and-funk-repeat)'s mask makes. The extent is `domain_start + round(domain_length × from)` to `domain_start + round(domain_length × to)`, where `from`/`to` come from `$se`; the comb cuts *the extent* into `2^(n+1)` equal chunks and keeps the even or the odd ones. An engine **MUST** store the region as a fraction and resolve it at read time, not bake it into byte offsets when the command is written: an Ixmp patch replaces the loop points under a sounding voice ([§4.1](#4-1-the-active-view)), and a baked extent would then name bytes the voice is no longer playing.

**The touch test.** A modification touches sample byte `i` when `i` lies inside the extent and inside a kept comb chunk; effect `2` inverts that answer **within the domain** and nowhere else — `2` spares its region and modifies the rest of the loop, never the rest of the file. Only touched bytes are transformed.

**The read order** at position `i`, replacing the plain fetch of [§8.1](#8-1-reading-a-sample):

1. Clamp `i` into the sample.
2. If the modification is live and touches `i`, apply its **address** transform, wrapping the result into the domain below. `i` now names a different byte.
3. Read the pool byte at `i`.
4. Apply the `S $Fx` mask of [§8.4](#8-4-invert-loop-and-funk-repeat), tested against the position **actually read** — a modification that moved the read also moved which mask bit answers for it. `S $Fx` is a separate, independent modification and the two do compose.
5. If the touch test of step 2 passed, apply the modification's **value** transform.
6. If a step is being crossfaded (below), repeat steps 2–5 with the **previous** transform state and mix.
7. Convert to `(b − 127.5) ÷ 127.5`.

Two positions are in play and an engine **MUST NOT** confuse them: the **touch test** is evaluated at the byte's *original* position, because that is where the region and comb are defined, while the pool read and the `S $Fx` mask use the position the address transform *moved to*. The modification's own address and value transforms never both fire — one operation is live at a time.

**The wrap domain** is the extent for effect `3` and the whole **domain** for effect `2`, whose touched set reaches both of its ends.

| Kind | Operations | Transform |
|---|---|---|
| Address, uniform | rotate, jump | Every touched byte moves by the *same* offset. Two of the three jump spellings quantise that offset to a whole eighth or sixteenth of the domain, so a loop cut to the bar is re-dealt a slice at a time |
| Address, per byte | scatter | Every touched byte moves by its *own* offset, drawn uniformly within the setting's fraction of the domain |
| Value, mask | invert loop (`$1`) | Bytes whose mask bit is set are XOR-ed with `$FF`. This mask spans the **whole sample**, unlike [§8.4](#8-4-invert-loop-and-funk-repeat)'s, which spans the loop: an inverted region's touched set is not contiguous, so there is no smaller origin to index from |
| Value, level | subtract | `b = (b − subtrahend) AND $FF` |

**Rotation accumulates; the random operations do not.** A rotate adds its step to the standing offset each step, so it sweeps. A jump replaces the offset with a fresh draw over the whole domain, and a scatter replaces the whole per-byte mapping — both measured from the sample's **original** position, never from the previous throw. An engine that accumulates them turns the narrowest setting into the widest one within seconds and collapses the ladder into a single effect with a rise time.

Where a jump spelling **quantises** its draw, the quantum is `round(domain_length ÷ n)` for `n` slices — **rounded**, not truncated, so the last slice boundary sits where the fraction says it does instead of a little short of it, and the error does not accumulate across the domain. The quantised spellings' outcomes therefore nest: every eighth is also a sixteenth, so the pair differ in grain and in nothing else.

**Scatter's per-byte offset MUST be a pure function of the byte's index** within a step, not a value pulled from a stream as bytes are read. One output sample reads the same position through every interpolation tap and through both channels of a stereo sample; an engine that draws afresh per read smears every setting into the same white noise. The reference engine draws one 32-bit seed per step and hashes it with the index. The mapping need not be a permutation: a source byte may be read twice and another not at all.

The draw **MUST** be **uniform** over ±reach. A normal draw was tried and reverted: leaving most bytes near home and flinging a few reads as noise mixed *under* the sample rather than as the sample breaking up, which is the opposite of what the operation is for. The ladder gets its range from the reach instead, and stops at an eighth of the domain — past that the bytes a throw lands among are uncorrelated with the ones it left, and every wider setting is the same band-limited noise.

**A step is crossfaded, not cut.** Installing a new address or value mapping between one output sample and the next is a discontinuity, and at the fastest clock that is one per tick — audibly, a stream of clicks. An engine **SHOULD** run each step in over a short window: the reference engine keeps the state the step replaced, reads **both** mappings for 64 output samples (2 ms at the reference rate) and mixes them on a linear weight that runs on the **output** clock — one weight per output sample, shared by every interpolation tap and both channels, so the crossfade of the two mappings is exactly the crossfade of the two interpolated signals. The window costs one extra pool read per tap while it runs and nothing at all afterwards. The invert-loop operation is exempt (one flipped byte is not a discontinuity), and so is changing or clearing the command, which is a deliberate edit rather than a step.

**Interpolation is unchanged.** Every tap of [§8.3](#8-3-interpolation) goes through the read order above, so the modification is heard through the same kernel the unmodified sample would be — as if the transformed bytes had been written into the pool. A scatter whose reach approaches the sample's own period therefore reads back band-limited and quieter, because the kernel is averaging bytes that no longer correlate. That is the correct result and an engine **MUST NOT** compensate for it.

**Nothing is ever written to the pool.** The modification is instrument-scope runtime state: it persists across rows and patterns within one playback, is **NOT** reset by a fresh note trigger (it is sample state, not note state), and **MUST** be cleared on a transport reset alongside the invert-loop mask, or a replay begins from a scrambled sample.

### 8.6 The sample-end ramp

When a voice reaches the end of a non-looping sample, or the volume envelope's cut rule fires, the engine engages an **8 ms linear ramp-out** (256 samples at the reference rate) rather than stopping instantly. During the ramp the sample position is held and the emitted value decays to zero, and the voice deactivates when the ramp completes. Re-engaging a ramp already in progress is a no-op, and a fresh trigger cancels any pending ramp so an attack is never muted by a stale one.

### 8.7 The attack ramp

A fresh trigger arms a countdown that feeds the same per-voice `ramp_gain` the sample-end ramp uses ([§10.2](#10-2-the-gain-chain)); the two multiply together when both are active, which only happens when a note is cut again inside its own attack. Where the sample-end ramp decays **linearly**, the attack ramp rises on a **half-cosine** curve:

```
ramp_gain = 0.5 − 0.5 × cos(π × i ÷ n)
```

`n` is the ramp's length — **~⅔ ms**, 21 samples at the 32 kHz reference rate — and `i` counts the output samples emitted since the trigger, `0` on the very first. The curve is exactly 0 at `i = 0`; every sample once `i` reaches `n` reads a flat `ramp_gain = 1.0`. A hard jump straight to full gain reproduces, on a loud or DC-offset sample, exactly the click the sample-end ramp exists to remove — the half-cosine shape is what the ear reads as smooth rather than merely fast, at a length short enough that a genuine percussive transient still lands inside the ramp's first sample or two.

A fresh trigger always re-arms the ramp at length `n`, even when the previous note's own attack ramp on that voice was still counting down — a trigger is a hard restart, so there is no "already ramping" case to no-op against, unlike the sample-end ramp. An NNA ghost spawned while its source voice's attack ramp is still running **MUST** inherit the remaining count rather than restart it or skip straight to unity gain: either alternative reproduces, at the hand-off, the exact click this ramp exists to prevent.

### 8.8 The pitch glide

Everything that moves a voice's pitch — slides, tone portamento, arpeggio, both vibratos, the pitch envelope — is evaluated **once per tick**, while the sample position advances **every sample**. Stepping `playback_rate` at the tick boundary therefore turns a smooth modulation into a staircase of 50 steps a second, which is audible on a sustained note as a rasp riding the vibrato. The engine keeps two rates instead: the tick writes a **target**, and the sampler steps by a **current** rate that glides toward it.

The glide is linear in playback rate and lasts `n` output samples, where

```
interval = max(target ÷ current, current ÷ target) − 1
n        = samples_per_tick                                if interval ≤ 2^(25/1200) − 1
           clamp(samples_per_tick × (2^(25/1200) − 1) ÷ interval, attack_ramp, samples_per_tick)   otherwise
```

The budget is **(interval × time)**, not time. A control move — a vibrato, an ordinary slide — travels a cent or two between ticks and is given the whole tick, which is the entire point of the glide. An **event** is not: an arpeggio step, a fast tone portamento arriving, a wide pitch slide are meant to be at the new pitch *now*, and bending two semitones across a tick's 20 ms is heard as a bend rather than a note change — a row of quick portamento notes becomes one continuous swoop. So a wider move gets a proportionally shorter glide, floored at the attack ramp's ~⅔ ms: enough to round the corner off, far too short to hear as pitch movement. Because it is a curve and not a threshold, a slide that speeds up shortens its glide smoothly rather than snapping between two behaviours mid-slide.

Two requirements:

- A **fresh trigger snaps** the current rate to the target: a new note starts at its own pitch and never bends up from whatever the channel last played. An NNA ghost inherits the source voice's rates but likewise begins at its target — an unfinished glide is not continued across the hand-off, and the gap it lands over is at most the budget above.
- The interval **MUST** be compared as a ratio, as written above, and not by converting to cents. The comparison decides a sample count, so a last-ulp disagreement in a logarithm is a rendering difference; §3.3's rule against logarithm round trips applies here for the same reason.

## 9. Filters

Two topologies, both mandatory. Which one a voice uses is decided by its instrument's (or patch's) filter mode.

Coefficients are recomputed only when cutoff or resonance has changed since the last refresh, which is checked once per tick.

### 9.1 The ImpulseTracker filter

A resonant **all-pole** 2-pole low-pass — no feedforward terms. This is not an approximation of the IT filter; it is the topology tracker playback needs to sound byte-faithful.

Cutoff 255 or above turns the filter off entirely. Otherwise, with `nyquist = 15999`:

```
c = clamp(cutoff, 0, 254) × 0.5                      → 0…127
r = (resonance ≥ 255) ? 0 : clamp(resonance, 0, 254) × 0.5
f = min(110 × 2 ^ (c ÷ 24 + 0.25), nyquist)
d = 10 ^ ((−r × 24 ÷ 128) ÷ 20)
R = rate ÷ (2π f)
D = d·R + d − 1
E = R²
a0 = 1 ÷ (1 + D + E)
b0 = (D + 2E) ÷ (1 + D + E)
b1 = −E ÷ (1 + D + E)
```

The recurrence, with the history taps clipped to ±2.0 (OpenMPT's `ClipFilter`, which keeps the resonant section from blowing up on pathological input):

```
y[n] = a0·x[n] + b0·clamp(y[n−1], ±2) + b1·clamp(y[n−2], ±2)
```

### 9.2 The SoundFont filter

FluidSynth's RBJ biquad, with cutoff in absolute cents and resonance in centibels above the DC gain. Cutoff `$FFFF` or above turns the filter off.

```
fc  = clamp(8.176 × 2 ^ (cutoff ÷ 1200), 5, 0.45 × rate)
qdB = clamp(resonance_cB ÷ 10, 0, 96) − 3.01          (0 cB ⇒ Butterworth)
Q   = max(10 ^ (qdB ÷ 20), 0.001)
ω = 2π·fc ÷ rate ,  α = sin ω ÷ (2Q) ,  a0inv = 1 ÷ (1 + α)
gain = a0inv ÷ √Q                                      (SF2 §2.01 gain normalisation)
b1  = (1 − cos ω) × gain ,  b02 = b1 ÷ 2
a1  = −2 cos ω × a0inv   ,  a2  = (1 − α) × a0inv
y[n] = b02·(x[n] + x[n−2]) + b1·x[n−1] − a1·y[n−1] − a2·y[n−2]
```

Direct Form I, unclamped — the gain normalisation bounds it. The −3.01 dB offset is what makes a SoundFont's declared Q = 0 cB come out Butterworth.

### 9.3 Runtime overrides

Effects `5` and `6` set an instrument-wide cutoff or resonance override, targeting the channel's instrument and every layer child's instrument. An argument of `$FFFF` clears the override. In IT mode the high byte is taken; in SoundFont mode the full 16 bits are. Overrides are runtime state and **MUST** be cleared on a transport reset.

An override is **absolute and instrument-wide**: while one is in force every voice of that instrument takes it, decoded and applied in the *instrument's* filter mode, whatever patch the voice resolved. Clearing it returns each sounding voice to **its own** default — the value in its patch's `x` block when it has one, the base record's otherwise. Dropping every voice onto the base record instead would retune a patched voice's filter, and where the patch and the base record disagree on SoundFont-versus-IT mode it would reinterpret the stored number in the wrong units.

## 10. Mixing

### 10.1 Voice effects

Before the mixer sees a sample, two per-voice effects may act on it, in this order:

1. **Overdrive** (`9`): multiply by `(16 + amount) ÷ 16`, then clip.
2. **Bitcrusher** (`8`): with a depth of 1…7, quantise to `2^depth − 1` levels; with a non-zero skip, hold the sample for `skip + 1` output samples.

Both share a **clip mode**: 0 clamps to ±1, 1 folds (a triangle characteristic), 2 wraps (a sawtooth characteristic). Fold and wrap are what give the effect its character; a plain clamp is the conservative choice.

For a stereo voice the parameters are shared but the crusher's hold state is per channel.

### 10.2 The gain chain

Per voice, per frame:

```
per_voice = envelope_volume            (1.0 when the volume envelope is toggled off)
          × fadeout_multiplier
          × current_mix_volume         (the ramped row × channel volume)
          × (1 + volume_swing_bias ÷ 255)
          × instrument_global_volume ÷ 255
          × (255 − fader) ÷ 255
          × layer_mix_gain
          × initial_attenuation_gain

global    = (song_global_volume ÷ 255) × (mixing_volume ÷ 255) × master_volume ÷ 255

sample_out = sample × per_voice × global × pan_gain × ramp_gain
```

`current_mix_volume` chases `(row_volume ÷ 63) × (channel_volume ÷ 63)` over a **2 ms linear ramp** (64 samples at the reference rate), which is what keeps volume-column edits from clicking. A fresh trigger **snaps** it instead of ramping, so a note's own target volume is reached immediately — the separate `ramp_gain` factor ([§8.6](#8-7-the-attack-ramp)) is what shapes the very start of the attack instead.

The envelope volume is likewise smoothed per sample: at each tick the engine computes a slope `(new_envelope_value − current) ÷ samples_per_tick` and adds it once per frame. Without this, a 50 Hz envelope staircase is audible on sustained material.

The **fader** is a host-owned 256-step attenuator per channel (0 = unity, 255 = muted) used for mute and solo. Muting a channel **MUST** also silence the ghosts and layer children it spawned: a background voice's effective fader is the larger of its own and its source channel's.

### 10.3 Panning

In the stereo model, an equal-energy law:

```
pan   = clamp(channel_pan + note_pan + envelope_pan_offset + pan_swing_bias + panbrello_offset, 0, 255)
left  = cos(π · pan ÷ 512)
right = sin(π · pan ÷ 512)
```

where `envelope_pan_offset` is `clamp(round(env_pan × 255), 0, 255) − 128` when the pan envelope is present and enabled, and 0 otherwise, and `panbrello_offset` is the `Y` LFO's signed contribution ([§6](#6-the-tick-pass) step 14), 0 on any row that does not run `Y`. There is no runtime choice of panning law.

`note_pan` is the per-note axis (TAUD_NOTE_EFFECTS.md §3a), a signed offset that is 0 unless an instrument or the panning column has written it — which is why a song that never touches it renders exactly as it did when the engine held one pan register. Note that the clamp is on the SUM: two axes that each sit inside the range can still add to a position outside it, and in a stereo song that saturates. The surround models wrap instead ([§11](#11-the-spatial-model)), so the identity between models holds for a summed position on the front arc.

For the planar and spatial models, see [§11](#11-the-spatial-model).

### 10.4 The post-mix Amiga chain

In Amiga 500 mode the stereo mix passes through a one-pole low-pass:

```
state ← mix × a0 + state × b1,   b1 = e^(−2π × 4420.971 ÷ rate),  a0 = 1 − b1
```

In both Amiga modes, when the LED filter is on, the mix additionally passes through the 3090.533 Hz second-order section. These act on the mix, after every voice has been summed.

## 11. The spatial model

The engine's spatial model is **object-based**: a sounding voice is a source with a direction and a gain, and the mixer knows nothing about output channels. A **renderer** turns those objects into bus channels, so an output format is always a render *target*, never something the engine holds. Playback installs a stereo renderer; an export installs whatever the chosen format wants and re-renders the same song through the same mixer.

The Kotlin reference engine does not implement this yet; the web engine is the reference implementation for this section.

### 11.1 Surround models

The song table's immutable `ss` flag selects one of three models, and it is immutable because it changes what the pan column *means*.

| Model | Meaning |
|---|---|
| 0 — stereo | The legacy two-accumulator path. The object bus is not allocated at all |
| 1 — planar | 360° panning on the horizon; elevation is forced to zero |
| 2 — spatial | The full sphere |

A planar or spatial song that uses only ordinary pan **MUST** render bit-identically to the same song in stereo mode. The stereo renderer therefore reuses the mixer's own `cos`/`sin` expression, and the object bus preserves the stereo path's factor order and accumulates in binary64. This is not an optimisation detail; it is the compatibility guarantee that lets a song change model without changing sound.

The guarantee is scoped to a **summed** position on the front arc (`channel_pan + note_pan`, TAUD_NOTE_EFFECTS.md §3a). The two pan spaces genuinely differ past that point — a stereo song's is a segment and saturates at its ends, a surround song's is a circle and turns — so a song that drives the sum beyond `$00`…`$FF` is no longer "using only ordinary pan" and the models are permitted to differ. In a surround song the effective direction is

```
azimuth = wrap(channel_azimuth + note_pan + envelope_pan_offset + pan_swing_bias + panbrello_offset)
elevation = channel_elevation + note_elevation
```

with the same addends as the stereo law, wrapping where that one clamps.

### 11.2 Angles

**Azimuth** is the 9-bit angle of the extended `S $8xxx` command: 512 units to a full turn, 0 = left, 128 = front, 256 = right, 384 = behind, increasing **clockwise** seen from above. Its low 8 bits are exactly the legacy pan byte, so pan `$00` / `$80` / `$FF` still mean left / centre / right and every ordinary pan write lands on the front arc.

**Elevation** is effect `X`'s signed byte: 128 units to 90°, −128 below, +127 ≈ above.

Both are continuous doubles, because the `Z` slide moves through them smoothly. Direction vectors use the AmbiX axes: +x front, +y left, +z up.

Two folds matter and are **not** the same operation:

- **Audible downmix.** A full-circle azimuth folds onto the pan byte by *mirroring* the rear arc onto the front: two speakers cannot render front versus back, so the left–right axis is kept and the other dropped. The mapping is the identity on the front arc, which is what makes ordinary pan behave identically in every model.
- **Position display.** The orthogonal projection onto the listener's left–right axis, `−cos(elevation) × sin(azimuth)`, is the *shadow* a source casts on that line: overhead and directly-behind both read centre. A channel-header pan strip draws this, which is why it lines up with a radar dot above it.

### 11.3 The stereo renderer

Sources on the front arc hit the legacy pan law exactly. Behind the listener the image folds forward; elevation collapses it toward the centre, so at ±90° a source is dead centre — the only choice that stays continuous at the poles.

```
p    = fold_to_pan(azimuth)
pan  = (elevation = 0) ? p : 128 + (p − 128) × cos(elevation)
left = cos(π·pan ÷ 512),  right = sin(π·pan ÷ 512)
```

### 11.4 Multi-channel samples

A multi-channel sample is **not** a set of speaker feeds. Each channel is placed as its own source, at an ITU-style angle offset from the source's own direction, as a rigid body aimed at the source — so a stereo pair keeps its 60° width however high the source flies, instead of collapsing at the poles the way a plain azimuth offset would.

| Channels | Offsets from the source direction (WAV channel order) |
|---|---|
| 1 | 0° |
| 2 | −30°, +30° (BS.775's equilateral triangle) |
| 4 | −30°, +30°, −110°, +110° |
| 6 | −30°, +30°, 0°, 0°, −110°, +110° |
| 8 | −30°, +30°, 0°, 0°, −90°, +90°, −135°, +135° |

Only mono and stereo are reachable today, since the sampler plays at most two pool spans; the placement *rule* is what this section pins down.

In the **stereo** model, multi-channel samples take a simpler path: each channel goes through the equal-energy pan law on its own side, so a stereo sample whose channels are identical renders bit-for-bit like the mono sample it was made from, and the pan column behaves as a mixer balance — hard left silences the right channel. A matrix-mode (mid/side) pair decodes to `L = M + S`, `R = M − S` **before** the filter and the voice effects, so those act on speaker feeds.

### 11.5 The `Z` slide

`Z` rotates a source toward the target set by effect `4`, along the **great circle**, at constant angular velocity — a spherical linear interpolation — by at most `argument ÷ 16` azimuth units per tick (the argument is in effect `X`'s units, which are half the engine's).

Identical directions do nothing. **Antipodal** directions, where the great circle is undefined, take the clockwise path, matching effect `P`'s rule; if the source is straight up or down, the rotation goes through its own azimuth instead.

### 11.6 Ambisonic rendering

The reference ambisonic renderer encodes to real spherical harmonics up to order 3, **SN3D normalised and ACN ordered** — the AmbiX convention. A `planar` variant keeps only the **sectoral** harmonics (`|m| = l`), giving 7 channels at order 3 instead of 16.

That variant is an internal scene basis, **not** a file layout: a written AmbiX file **MUST** carry the complete `(order + 1)²` set, encoded from the full basis. Zero-filling the channels the planar variant drops would be a different scene, because a horizontal song still excites the zonal harmonics — ACN 6 is `(3z² − 1) ÷ 2 = −½` at ear level, not zero.

Its stereo monitor decode is the classic coincident cardioid pair at ±90°: `L = (W + Y) ÷ 2`, `R = (W − Y) ÷ 2`.

### 11.7 Other render targets

Everything below is a render *target* in the sense of §11: the same song, the same mixer, a different renderer. None of it changes what a file means, so an implementation **MAY** offer any subset — but where it offers one of these, these are the rules.

**Speaker layouts.** Sources pan pairwise around the horizontal ring — constant power between the two speakers that bracket the azimuth, exact at every speaker — at the BS.775 / BS.2051 angles (±30° front pair, centre ahead, ±110° surrounds; 7.1 splits those into ±90° sides and ±135° rears). Elevation, which no such layout can reproduce, blends the source toward an even spread over the ring as it climbs, reaching fully diffuse at the poles: level-preserving and continuous, the n-speaker generalisation of the stereo fold's collapse toward the centre. The LFE channel receives **nothing**; there is no bass-management stage defined here.

**Binaural monitoring.** An implementation **MAY** monitor a surround song through a head model so that elevation and front/back are audible on headphones — without it, composing a height is composing something the composer cannot hear. It is a *monitor*, not a rendering rule: the stereo output an implementation writes or plays by default is still the fold of §11.3, and nothing about a file depends on the head model chosen.

The reference implementation encodes the objects into an order-3 ambisonic scene — the same SN3D/ACN basis as §11.6, so the monitor bus *is* a B-format scene — and decodes that scene to two ears with a **measured spherical-harmonic HRIR set**: one FIR per ambisonic channel, and both ears out of one pass, because mirroring a listener left↔right negates every harmonic with `m < 0` and leaves the rest alone. So `L = Σ_{m ≥ 0} + Σ_{m < 0}` and `R = Σ_{m ≥ 0} − Σ_{m < 0}`, over the per-channel convolutions. The set used is GoogleVR/SADIE's (16 channels × 256 taps at 48 kHz, Apache-2.0), rate-converted if the engine is not running at 48 kHz. Interaural delay, head shadow and the pinna's spectral cues arrive with the measurements; there is no parametric head model, and no per-source filtering at all.

A planar song decodes only the harmonics that survive on the horizon (`l − |m|` even — 10 of the 16 at order 3). Unlike §11.6's sectoral variant that is not an approximation: the six dropped harmonics are identically zero for every source a planar song can place, so the decode is sample-for-sample the spatial one.

One scalar calibrates the set so that a source dead ahead leaves the head carrying exactly the power the pan law of §11.3 gives it. Every other direction keeps whatever level the measurements say — a real head is a few dB quieter behind and below, and that difference is itself a direction cue, not an artefact to flatten.

## 12. Output stage

The mix accumulates in binary64, narrows to binary32, passes through the song's mastering chain, is clamped, and is dithered to 8 bits. The order matters: a chain downstream of the clamp would have nothing left to work on, and a chain upstream of the Amiga filter ([§10.4](#10-4-the-post-mix-amiga-chain)) would be shaping a signal the device never delivers.

### 12.1 The mastering chain

The chain is declared per song in the `sMst` Project-Data section (**Taud File Format** §9.12) and a conforming player **MUST** honour it: it is part of how the song sounds, not editor state. A song that declares no chain, or declares one with every stage switched off, renders exactly as it would without this section — implementations **SHOULD** skip the stage entirely in that case, which is also what keeps such a song bit-identical to a render made before this section existed.

Parameters are stored as binary32 and coefficients are computed from them in binary64. Every stage has its own on/off switch, plus one for the chain as a whole, and the order is FIXED:

```
trim → high-pass → equaliser → compressor → stereo width → limiter → output gain
```

**Trim** and **output gain** are plain multiplications by `10^(dB ÷ 20)`. The output gain is applied AFTER the limiter, so it can push the signal back over the ceiling; that is deliberate and is the composer's decision to make.

**High-pass** is a Butterworth response at the declared corner: one RBJ high-pass section at Q = 0.7071 for the 12 dB/octave slope, or two cascaded at Q = 0.5411961001461969 and Q = 1.3065629648763766 for 24 dB/octave.

**Equaliser** is four cascaded RBJ cookbook sections, Direct Form I, normalised to `a0`, with an independent delay line per channel. Band 1 may be a low shelf or a bell, band 4 a high shelf or a bell; bands 2 and 3 are always bells. A band that is switched off is not in the cascade at all.

**Compressor** is feed-forward with a quadratic soft knee, computed and smoothed in decibels. The detector is **linked** across the pair — one envelope drives both channels, so the stereo image does not move — and reads either the frame's peak, `max(|L|, |R|)`, or its RMS through a 10 ms one-pole average of `(L² + R²) ÷ 2`. With `over = level_dB − threshold` and a knee width `W`:

```
reduction_dB = 0                                             over ≤ −W/2
             = −(1 − 1/ratio) · (over + W/2)² ÷ (2W)         |over| < W/2
             = −over · (1 − 1/ratio)                          over ≥ W/2
```

The running reduction chases that target through a one-pole whose coefficient is `1 − e^(−1 ÷ (ms ÷ 1000 × rate))`, using the attack time when the target is lower than the current reduction and the release time otherwise. The make-up gain multiplies the result. A detector level below −120 dBFS reads as −120 dB.

**Stereo width** scales the side signal: `M = (L + R) ÷ 2`, `S = (L − R) ÷ 2 × width`, then `L = M + S`, `R = M − S`. A width of exactly 1 **MUST** be the identity rather than that round trip.

**Limiter** is a look-ahead brickwall over a window of `D = round(0.001 × rate)` samples, and the construction is normative because the ceiling is a guarantee rather than a target:

1. For each frame compute the gain it would need to sit at the ceiling: `g = ceiling ÷ peak` when `peak > ceiling`, else 1. `peak` is `max(|L|, |R|)`, or — when the true-peak flag is set — the largest magnitude among the frame and the four points the 4× oversampler below interpolates around it, over both channels.
2. Take the sliding **minimum** of `g` over the last `2D + 1` frames.
3. Rate-limit that envelope's RISE with the release one-pole (falls are instantaneous).
4. Take the moving **average** of the result over the last `D + 1` frames.
5. Apply it to the audio delayed by `2D`.

Steps 2 and 4 together are what make overshoot impossible: every minimum the average covers is taken over a window that still contains the frame being emitted, so the mean can never exceed that frame's required gain, and the rise limit only lowers it further. A moving average alone does not have that property. The chain's latency is therefore `2D` frames whenever the limiter is on, and zero otherwise.

The true-peak oversampler is a 32-tap Hann-windowed sinc split into four 8-tap polyphase branches, each normalised to unity DC gain on its own:

```
h[i] = sinc((i − 15.5) ÷ 4) · (0.5 − 0.5 cos(2πi ÷ 31)),   i = 0…31
branch p uses h[4k + p], k = 0…7, divided by Σ_k h[4k + p]
```

A transport reset clears every delay line and envelope in the chain — see [§15](#15-transport-reset).

Everything above describes the chain acting on the **stereo pair** the output stage delivers. [§12.3](#12-3-multichannel-delivery) defines what the same chain means where the delivery has more channels than that.

### 12.2 Narrowing and dither

After the chain:

1. Convert each channel's frame to **binary32**, then clamp to ±1.0 **in binary32 space**. Clamping before narrowing gives different results at the boundary.
2. Store into a binary32 mix bus.

Quantisation to 8 bits is **noise-shaped dither**, per channel, with second-order error feedback:

```
feedback = 1.5 × e[n−1] − 0.75 × e[n−2]
dither   = 0.2 × (u1 − u2)                     u1, u2 uniform in [0,1)
shaped   = clamp(x + feedback + dither ÷ 127.5, −1, 1)
q        = clamp(round(shaped × 127.5), −128, 127)
out      = (q + 128) & $FF
e[n]     = shaped − q ÷ 127.5
```

Every arithmetic step in this loop **MUST** be evaluated in binary32, and the dither source **MUST** be the engine's own seeded generator, not the host's. Together those two rules are what make 8-bit output reproducible across implementations.

The uniform values are drawn as `(xorshift32() & $FFFFFF) ÷ 16777216`, which is exact in binary32.

### 12.3 Multichannel delivery

A file with more than two channels is not written from the pair of [§12.1](#12-1-the-mastering-chain): it is written from the channel bus of [§11](#11-the-spatial-model) — a speaker layout's feeds, or an ambisonic scene. An implementation that offers such a target and honours `sMst` **MUST** master it there, as a **multichannel master**: one chain, as wide as the bus, carrying the song's own parameters. This section is what that means. Everything not named here is exactly [§12.1](#12-1-the-mastering-chain).

**Trim, high-pass, equaliser and output gain** apply to every channel with the **identical** coefficients, each channel keeping its own delay lines. Identical is not a convenience: a listener's decoder is a fixed linear matrix, so filtering the channels and then decoding gives the same result as decoding and then filtering. A per-channel difference would be a filter on the *direction* rather than on the programme, which is a thing the parameters do not say.

**The compressor** runs one detector over **all** channels. In peak mode the frame's level is `max |x_c|` over every channel `c`; in RMS mode it is the one-pole average of `Σ x_c² ÷ N`. The resulting gain multiplies every channel. A per-channel envelope would pull the sound field about whenever one direction got loud — the same objection as the stereo detector's, and a louder one when the channels are speakers.

**Stereo width is skipped.** It is defined on a pair and has no meaning off one; a mid/side round trip over any two channels of a speaker layout or an ambisonic basis would shear the field rather than widen it. A chain whose only engaged stage is width therefore leaves a multichannel file untouched.

**The limiter** is the construction of [§12.1](#12-1-the-mastering-chain) with `peak` taken as the largest magnitude over **all** channels — over every channel's oversampled points when the true-peak flag is set — and its gain applied to every channel. So the ceiling is a promise about the samples **in the delivered file**. It is not a promise about any particular decode of them: a decoder that sums channels may exceed it, and an ambisonic file's decoded speaker feeds routinely will. The latency is `2D` frames on every channel, as before.

**Numerically**, the channel bus carries binary64 throughout — [§12.2](#12-2-narrowing-and-dither)'s narrowing exists for the 8-bit device, which a multichannel file is not. The chain runs in binary64 and the samples narrow **once**, where the file is written, at whatever depth it is written in. No clamp is defined here; saturation is the writer's quantiser's business.

A multichannel master is **not** the multichannel form of the stereo master, and an implementation **MUST NOT** present it as one. The static stages do agree — identical linear filters commute with the fold of [§11.3](#11-3-the-stereo-renderer) — but the dynamics cannot: the pair's detector reads the fold, the bus's detector reads the channels, and the two disagree wherever the fold is quieter or louder than the loudest channel. No single set of dynamics serves both deliveries. What a device **plays** is unaffected either way: that is still the pair.

## 13. Determinism

The engine has two random streams, and they serve opposite purposes.

- **The dither PRNG** is a 32-bit xorshift seeded to a constant per engine instance. It is deterministic by design: two runs of the same song produce byte-identical 8-bit output.
- **The musical randomness source** backs the random LFO waveform, the per-trigger volume and pan swing, the sample modifications' jumps and scatters, and funk repeat's two random walks. In production it is the host's uniform generator, so a song using volume swing sounds slightly different on every play — which is what swing is *for*.

An implementation **MUST NOT** call the host's random generator directly from engine code; both streams **MUST** be injectable, or conformance testing against a reference render becomes impossible. A song that uses neither swing nor the random waveform renders deterministically.

Under those conditions, and with the numeric rules of [§12](#12-output-stage), independent implementations agree **bit-for-bit** — both on the pre-dither float bus and on the dithered 8-bit output. That is the conformance bar this specification sets, and it is met in practice: the JavaScript and Kotlin engines match exactly across the reference corpus.

## 14. Interrupts and the host interface

Note words `$0010`…`$001F` are **interrupt markers**: they produce no sound and have no built-in behaviour. Processing one latches bit *n* in the playhead's pending-interrupt mask.

The host drains the mask with a **read-to-acknowledge** call that returns and clears it. Latching accumulates, so no fire is lost between drains, but repeated fires of the same interrupt between two drains collapse into one bit — the semantics are edge-triggered and level-collapsed. A host dispatches its own callbacks from the drained mask.

Interrupts are how a song drives something outside itself: lighting cues, subtitle timing, game events.

## 15. Transport reset

A transport reset restores a well-defined starting state, and getting its scope right prevents a family of "mysteriously lingering" bugs.

A **full reset** sets BPM 125, tick rate 6, global and mixing volume `$80`, clears the tuning, restores the tone and interpolation modes from the file's global behaviour flags, re-installs the surround model, clears the Amiga filter states, returns the mastering chain to neutral, deactivates every voice, empties the background pool, clears every per-voice effect and envelope state (funk repeat's loop window among it), and clears the per-instrument runtime state (invert-loop masks and filter overrides).

A **play-from-row** reset is narrower and deliberately so: it resets row, tick and jump state, deactivates every voice, **empties the background pool**, clears the per-channel pattern-loop and Ditto state, reconstructs the Ditto arm state for the starting row, returns every channel to its song-start position, volume and colouring (the bitcrusher and the overdrive among it), and clears the mastering chain's delay lines and envelopes — but leaves the playhead's tempo and volumes alone, because a replay must keep the song's tempo. The chain's PARAMETERS are the song's and survive, like the tempo; its STATE is per-play, like the ghost pool. A compressor still holding six decibels of reduction from before a seek, and a look-ahead buffer still holding two milliseconds of the previous playback, are both the lingering-state bug this section exists to prevent.

Returning the CHANNELS is not the same thing as leaving the playhead's tempo alone, and both halves matter. Channel volume and every panning axis (channel position and elevation, the note axis, the spherical slide target), glissando, the bitcrusher and overdrive settings (`8 $xyzz` and `9 $x0zz`, the clipper they share included) and the `S $7x` per-note overrides are all written by the song's own effects and reset by nothing else — a trigger deliberately leaves them, since they belong to the channel rather than the note — so a play that does not clear them starts wherever the last one finished. What a reset **MUST NOT** touch is the host's own mixer: per-channel mute and fader levels belong to whoever is listening, not to the song, and a replay that silently unmutes a channel is its own bug.

Emptying the background pool is the part that is easy to omit and audible when omitted: a stop leaves ghosts active, and a replay resumes them.

A host loading a new document **MUST** perform a full reset before uploading it, and **MUST** then upload the song's own mastering chain — or the neutral one when the file declares none. Nothing in a file describes the channel state the previous song left behind, so a document loaded on top of another inherits its panning, its channel volumes and its mastering otherwise.

## 16. Effects

The effect column is specified in full in the **Note Effects** reference, including per-effect memory cohorts, recall rules and the conversion tables for ProTracker, ScreamTracker 3, FastTracker 2 and ImpulseTracker sources. This document defines only the machinery those commands drive.

Opcodes are base-36 digit values: `0`…`9` are `$00`…`$09` and `A`…`Z` are `$0A`…`$23` — except `:` (Format 3 only), which lives in a second, ASCII-symbol opcode space (`$A0`…`$FE`, decoded as `opcode − $80`) opened once the base-36 one filled. A few carry engine-scope rather than voice-scope meaning and are worth naming here:

| Opcode | Scope | Engine effect |
|---|---|---|
| `:` | Row | Argument extension — hands its argument to whichever other effect shares the row, resolved once per row before either slot dispatches ([Note Effects](TAUD_NOTE_EFFECTS.md#-xxxx--argument-extension-format-3-only)); a bare no-op outside Format 3 |
| `1` | Playhead | Set the global behaviour flags — tone mode and interpolation — from the argument's high byte |
| `5` / `6` | Instrument | Cutoff / resonance override, `$FFFF` to clear |
| `7` | Channel, row-time | Pattern Ditto ([§5.9](#5-9-pattern-ditto)) |
| `8` / `9` | Voice | Bitcrusher / overdrive ([§10.1](#10-1-voice-effects)) |
| `A` / `T` | Playhead | Tick rate / tempo |
| `B` / `C` | Playhead | Order jump / pattern break, both resolved at row end |
| `V` / `W` | Playhead | Set / slide the song global volume |
| `4` / `X` / `Z $0xxx` | Voice | Spatial target, position and slide — ignored entirely in a stereo song |
| `Z $Ffxx` | Voice | Funk repeat: walk the sounding loop window through the sample, `$f` picking the hop ([§8.4](#8-4-invert-loop-and-funk-repeat)) — a sampler command, live in every song |

## 17. Conformance summary

An implementation conforms when all of the following hold.

- Timing is accumulated per sample, with `samples_per_tick` recomputed every frame, so block size is not observable.
- Row events fire at the row boundary and the row's tick passes then run with tick indices 0…`tick_rate − 1`.
- All playback state reads the trigger-time active views, never the live instrument record.
- The volume and pan envelope walker freezes on zero-duration nodes; the pitch and filter walker skips them, and seeds settle past leading ones.
- The volume envelope's cut rule fires on a zero-valued terminator with no active wrap.
- NNA ghosts carry the complete voice state, including both filter topologies' delay lines.
- Duplicate Check runs before the NNA spawn and consults the *existing* voice's instrument.
- A note delay's trigger re-binds the instrument for the remainder of that tick.
- Sample ends and envelope cuts ramp out over 8 ms; volume changes ramp over 2 ms, and `current_mix_volume` snaps rather than ramps on a trigger.
- A fresh trigger separately fades `ramp_gain` in from silence over a ~⅔ ms half-cosine attack ramp, inherited by an NNA ghost spawned mid-ramp.
- Pitch glides toward the tick's target on an (interval × time) budget, so a vibrato is smoothed across the tick while an arpeggio step or a fast portamento arrival still lands at once.
- A planar or spatial song that uses only ordinary pan renders bit-identically to the stereo model.
- The mastering chain runs between the narrowing and the clamp, in the order §12.1 fixes, and a song that declares none renders as though the stage did not exist.
- The limiter's ceiling is never exceeded, on any material, in either peak mode.
- A multichannel delivery masters the channel bus per §12.3: identical filtering on every channel, the dynamics detectors linked across all of them, and no stereo width.
- The output stage narrows to binary32 before clamping, and runs the dither loop entirely in binary32 against a seeded generator.
