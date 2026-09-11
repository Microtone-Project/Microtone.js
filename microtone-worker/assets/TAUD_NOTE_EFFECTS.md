# Taud Tracker Effect Command Reference

Taud is a tracker-style music format derived from ScreamTracker 3's pattern command set, extended to 16-bit effect arguments and a 4096-tone equal-temperament pitch grid. This document defines every effect command a Taud engine **MUST** implement. Each command entry has three parts: a plain explanation for composers, compatibility notes for converting patterns from ScreamTracker 3 (ST3), ImpulseTracker (IT), FastTracker 2 (FT2) or ProTracker (PT), and implementation details for engine writers.

## Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold. Lowercase uses of these words carry their ordinary English meaning and impose no normative requirement.

In short:

- **MUST** / **MUST NOT** / **REQUIRED** / **SHALL** / **SHALL NOT** — absolute requirements / prohibitions. A conforming implementation **SHALL** observe every such rule; an implementation that violates one is non-conforming.
- **SHOULD** / **SHOULD NOT** / **RECOMMENDED** / **NOT RECOMMENDED** — strong guidance. An implementation **MAY** deviate in particular circumstances, but the full implications **MUST** be understood and weighed before doing so.
- **MAY** / **OPTIONAL** — truly optional. Implementations that include the feature and implementations that omit it are equally conforming, and each **MUST** be prepared to interoperate with the other (with reduced functionality where the optional feature is the means of interoperation).

The "Plain" paragraph of each effect description is non-normative tutorial text; the **Compatibility** and **Implementation** paragraphs carry the normative requirements, expressed through the keywords above.

All hexadecimal numbers are prepended with a `$` (dollar sign).

## 0. Tracker terminologies

This manual extensively uses "tracker lingo" that may not sound intuitive to the modern DAW users. This section covers some of the tracker lingo to get the concepts better understood for those who have never used trackers.

* **Pattern.** A rectangular block of rows × channels, conceptually similar to a MIDI clip in a DAW but on a strict grid: at most one note event per row per channel. Patterns have a fixed row count (typically 64), and the entire song is assembled by sequencing patterns rather than by placing clips on a continuous timeline.

* **Cue list** (also called *order list* in other trackers). The song-level playlist of pattern indices that defines playback order. The same pattern can appear in many cue slots — editing the pattern updates every occurrence. There is no continuous timeline; the song's runtime is whatever the cue list yields, navigated by effects B (jump) and C (break). Some trackers use one cue slot that spans the entire channels; Taud uses per-channel cues.

* **Channel / Voice.** A vertical column within every pattern, fixed in count for the whole song (closer in spirit to a mixer channel than a DAW track). Each channel plays at most one note at a time; chords need multiple channels. Channels persist their state — volume, pan, vibrato phase, filter — across pattern boundaries.

* **Row.** One horizontal slot within a pattern, at most one note event per channel. A row's duration is `speed × tick_duration` — see Speed and Tempo below.

* **Ticks.** A row spans several ticks dictated by a "tick rate". All note effects happen on those ticks while playing. Some effects (notably sliding effects, excluding fine slides) require more than one tick for operation, and **MUST NOT** be applied when the tick rate is set to 1.

* **Speed vs. Tempo.** Two independent timing knobs. **Speed** (effect A) is the number of ticks per row; **tempo** (effect T) sets the duration of one tick, conventionally expressed as BPM. To slow the song globally without changing how often per-tick effects update, lower the tempo. To give per-tick effects more iterations per row (denser vibrato, longer slides per row), raise the speed. The default is speed 6, tempo $64 → 125 BPM → 50 Hz tick rate → 120 ms per row.

* **Effect column.** Each cell can carry one effect command (opcode + 16-bit argument) that fires on its row. Unlike a DAW automation lane, effects are inline with the notes — there is no continuous curve, only discrete per-row events that compose with the engine's tick loop.

* **Volume column / panning column.** Two extra mini-lanes per cell, each carrying its own 6-bit value + 2-bit selector (set / slide-up / slide-down / fine-slide). They run alongside the main effect column, so a single cell can carry both a main effect *and* a volume-column slide.

* **Effect memory / recall.** Most effects remember their last non-zero argument; re-issuing the same effect with `$0000` recalls and re-applies it. This is how trackers express "continue that slide" without re-typing the rate every row. Each effect has either a private memory slot or shares one with a small cohort of related effects (see §6).

* **Fine slides** are basically "relatively set something" operations. They apply delta on the first tick of the row only.

* **Instruments vs. samples.** Notes don't reference a sample directly — they reference an **instrument**, which wraps a sample with envelopes (volume / pan / pitch), a default note volume, an NNA (New Note Action; see below), and a fadeout setting. The same sample can be wrapped by several instruments with different envelopes, much like a sampler patch in a DAW.

* **Sample loops.** Held notes don't work the way a DAW sustain pedal does. The sample itself contains a loop region (loop_start..loop_end) that the playhead replays endlessly until the note is released or cut — "sustain" comes from the sample data, not from a held key.

* **Note off, note cut, note fade.** Three distinct ways a note ends. **Note cut** (`^^^` or `S $Cx`) silences instantly. **Note off** (`===` or an NNA = NoteOff) releases the sustain loop and lets the volume envelope's release segment play out, then fades. **Note fade** keeps the sustain loop running but begins the fadeout decay — for soft tail-offs that still sound sustained.

* **NNA — New Note Action.** What happens to a still-playing note when a fresh note arrives on the same channel. Options are Cut (drop the old voice), Continue (let it ring through), Note Off (release it), or Note Fade (begin fadeout). The displaced voice becomes a background *ghost* voice — still audible but no longer addressable from the pattern. This is the tracker's substitute for polyphony across DAW MIDI clips.

* **Portamento.** Automatic pitch glide toward a target note (effect G). A row carrying both a note *and* a G does **not** re-trigger the sample; instead the note becomes the target and the already-sounding sample slides into it. Distinct from generic pitch slides (E/F), which move pitch by a fixed amount per tick with no target.

* **Vibrato / tremolo / panbrello.** Per-channel LFOs applied to pitch (H, U), volume (R), and panning (Y) respectively. Each has independent speed, depth, and waveform. These are not DAW automation envelopes — they're cyclic modulators, more like a synth's LFO knob.

* **Arpeggio.** A chip tune staple: rapidly cycle one channel between three pitches across consecutive ticks to fake a chord on a single voice (effect J). At the default 50 Hz tick rate the cycle is fast enough to perceive as a chord rather than three separate notes.

* **Sample offset.** Start sample playback partway into the sample data rather than at byte 0 (effect O). Common uses: trigger a long sample mid-attack to skip a slow onset, or pick a different drum hit from a multi-sample bank.

* **Pattern jump / break / loop.** Three flow-control tools without a direct DAW analog. **B** jumps to a cue index; **C** breaks out of the current pattern into a specific row of the *next* one in the cue list; **`S $Bx`** sets a per-channel loop point and repeats the bracketed range a fixed number of times. They operate on the cue list, not on a timeline. This pattern-wise flow control (including delays. see below) applies to the entire channels; there will be no divergence where one channel loops but other channels don't.

* **Pattern delay / fine pattern delay.** **`S $Ex`** repeats the current row N additional times (notes don't re-trigger across repetitions, but tick-0 events do); **`S $6x`** extends the current row by N additional ticks without repeating it. Together they let composers stretch row timing locally without touching global speed or tempo.

* **Volume fadeout.** A linear per-tick volume decay applied after key-off (or NNA Note-Fade). For sustained instruments whose volume envelope holds non-zero forever, the fadeout is the *only* mechanism that eventually retires the voice — without a stored fadeout, key-off lets such voices ring indefinitely.

* **Metainstrument, and its two kinds.** An instrument slot that names *other instruments* instead of holding a sample of its own. **Metainstrument** is the family; a record's type nibble says which kind it is, and there are two: a **Layered** metainstrument (type 0) sounds every entry that the trigger falls inside, in parallel, one voice each; an **FM Rack** (type 4) reads the same entries as FM **operators** and an algorithm packed after them wires those into each other, so the whole rack is **one voice**. Both are one note on one channel, which is why the rules below that begin *"Metainstruments."* apply to either kind: where they say *layer children*, they mean the child voices a meta spawns — a stack's further layers, a rack's further operators. Where a rule is one kind's alone it says so. See [File Format §7.4](TAUD_FILE_FORMAT.md#7-4-metainstrument-records) and [Engine Spec §5.5](TAUD_ENGINE_SPEC.md#5-5-metainstruments).

## 1. Sound device

- **Bit depth:** 8-bit unsigned throughout, including the final mixdown. Conforming implementations **MUST** deliver 8-bit unsigned samples at the output stage.
- **Sample rate:** 32000 Hz, the TSVM Audio Adapter's rate and the reference rate every sample count in this document is quoted against. A host **MAY** instead run the engine at its own output rate — the browser implementation renders 48 kHz — provided everything rate-derived is recomputed from it and the music lands on the same rows at the same times; see the Engine Spec §1.3 for the exhaustive list.
- **Output channels:** strictly stereo; the mix bus **MUST** always produce a two-channel frame, even for mono-source samples.

Internal accumulators **MAY** widen to 16 or 32 bits during mixing and effect computation, but stored samples and final output **MUST** be 8-bit.

## 2. Pitch system — 4096-TET

One octave spans **4096 pitch units** ($1000 exactly). A 12-TET semitone therefore equals **4096 ÷ 12 ≈ 341.333 units** (≈ $0155.55), which is not an integer; this irrationality is a deliberate consequence of choosing a microtonal native grid. Implementations **MUST** store channel pitch as a signed integer in Taud units, and **MUST** convert to playback rate using

```
playback_rate = reference_rate × 2 ^ (pitch_units / 4096)
```

Commonly used intervals in Taud units are listed below; all are rounded to the nearest integer.

| Interval | Units (exact) | Hex (rounded) |
|---|---|---|
| Octave | 4096 | $1000 |
| Perfect fifth (7 ST) | 2389.33 | $0955 |
| Tritone (6 ST) | 2048 | $0800 |
| Major third (4 ST) | 1365.33 | $0555 |
| Minor third (3 ST) | 1024 | $0400 |
| 1 semitone | 341.33 | $0155 |
| 1/8 semitone (1 finetune) | 42.67 | $002B |
| 1/16 semitone | 21.33 | $0015 |
| 1/64 semitone | 5.33 | $0005 |
| 1 cent (1/100 semitone) | 3.41 | $0003 |

## 3. Volume system

Per-note and per-channel volume runs from **$00 (silent) to $3F (full)**, a 6-bit range narrower than ST3's 0..$40. Global volume (effect V) runs 0..$FF; this wider range lets the mix bus scale the summed channel output without disturbing individual note volumes. Conforming engines **MUST** implement the per-frame mix chain per channel as

```
mix = sample × note_vol × channel_vol × global_vol >> normalisation_shift
```

with saturation applied before the 8-bit stereo output. Internal accumulators **MAY** widen during this computation (see §1), but the saturating clip to the 8-bit range **MUST** be performed at the boundary.

`note_vol` and `channel_vol` are **two independent multiplicative axes** mirroring IT's `chan->volume` and `chan->global_volume`:

- **`note_vol`** is the per-note axis. It is reset on every note re-trigger to the instrument's Default Note Volume (instrument-record byte 196). It is the target of the volume column (selectors 0 / 1 / 2 / 3), the D / K / L volume slides, and the Q retrigger volume modifier. It survives across rows until the next re-trigger.
- **`channel_vol`** is the per-channel axis. It is **not** reset by note re-triggers — once set, it persists through any number of fresh notes on that channel. It is the target of M (set) and N (slide) only.

The engine carries a third per-tick value, `row_vol`, which is the mixer-facing volume for the current tick. At every row boundary `row_vol` rebases to `note_vol`; per-tick modulators (tremolo R, tremor I) write `row_vol` only, so their effect dies cleanly at row end. Per-note slides (D, K, L, vol-col) write **both** `note_vol` and `row_vol` so the per-note baseline carries forward.

Because the two axes are independent, an `M $4000` (set channel volume to full) issued after a `0.$02` (vol-col SET = 2) leaves the per-note volume untouched at 2 — the channel keeps playing quietly. Conversely, an `N` slide can fade out a channel's overall level while a vol-col SET on a fresh trigger sets the per-note baseline at full.

## 4. Panning system

Panning has **the same two axes as volume, in the same places**, and a conforming engine **MUST** keep them as two registers:

- **`note_pan`** is the per-note axis: where the NOTE sits. It is a **signed offset**, neutral at zero, and it is the target of everything an INSTRUMENT says about panning — its Default Pan (record byte 177, gated by the pan envelope's `p` bit), an Ixmp patch's per-zone Default Pan ([file format §9.11](TAUD_FILE_FORMAT.md)), and Pitch-Pan Separation — together with all four selectors of the **panning column**. Like `note_vol` it survives across rows; unlike `note_vol` it is re-seeded only by a trigger that actually carries an instrument-level pan, so a panning-column SET stands until an instrument overrides it or the column speaks again.
- **`channel_pan`** is the per-channel axis: where the PART sits. It is an absolute position — a byte in a stereo song, a 9-bit angle (plus an elevation) in a surround one — and it is the target of **S $80xx, P, X, 4 and Z only**. An instrument **MUST NOT** write it, and a note re-trigger never resets it.

The mixer adds them, then the pan law applies to the sum:

```
position = channel_pan + note_pan + (pan_env − $80) + random_pan_swing
```

clamped to `$00..$FF` in a stereo song and wrapped round the circle in a surround one.

**Why two axes.** An instrument whose panning changes with pitch — an Ixmp bank with a per-zone pan, the usual shape of an SF2 import — is a spatial ARRANGEMENT, not a position. Putting the arrangement on the note axis means a channel pan **rotates** it as a whole (`S $8040` swings the entire zone-panned keyboard 64 units left, and each zone keeps its own place within it) instead of flattening it into one spot that the next note immediately overwrites. This is the same rule that already governs a multi-channel sample, whose channels are placed at ITU angles **relative to the source's own direction** (see "Spatial panning effects"): the arrangement is relative, the channel's direction is absolute.

**The rule is general, and it nests.** Stated once: *a pan command places a sound's CENTRE, and everything sounding within it keeps its offset from that centre.* For a single voice the centre is the voice, so a note-pan SET simply places it and a zone pan is replaced outright. For a **metainstrument** several voices sound at once, and a command cannot place them all at one point without destroying what it is placing — so the SET places the meta's centre (layer 0, as it already does for detune) and every layer keeps its distance. A conforming engine **MUST** therefore hold a layer's own default position as a distance from layer 0's rather than as an absolute place; a layer that declares none rides at zero offset. A single-layer meta and a plain instrument are the degenerate case of this and behave exactly as the paragraph above describes — and so is an **FM Rack**, however many operators it holds: a rack is one signal sitting where the channel sits, so its operators carry no position of their own ([Engine Spec §5.5.1](TAUD_ENGINE_SPEC.md)).

**And what overrides what.** Because the panning column writes the note axis, a column SET is the way to say "this note goes HERE, never mind the zone" — it replaces the instrument's seed for that note, exactly as a volume-column SET replaces the instrument's Default Note Volume. `S $80xx` cannot do that job and no longer tries to: it moves the channel, and the note keeps its offset within it.

**Bit-identity across surround models.** A song whose *summed* position stays on the front arc renders identically whichever surround model it declares. Past the arc the models genuinely differ, because their pan spaces do: a stereo song's is the segment `$00..$FF` and saturates, a surround song's is a circle and turns (the stereo monitor then folds the rear position back onto the front arc).

**Compatibility.** A file that never writes the note axis renders exactly as it did under the single-register engines, since the axis is neutral at zero and the sum degenerates to `channel_pan`. Songs converted from IT / XM / S3M are unaffected in the common case for the same reason: their instrument pans and pan-column writes both land on the note axis, and `channel_pan` stays at its `$80` default unless the song uses S $80xx or P. Where a song uses *both*, the two now COMPOSE where a single register would have had the later write clobber the earlier one.

## 5. Rows, ticks, patterns, cues

A pattern is a rectangular grid of rows and channels; each cell holds one note event. Playback divides each row into `speed` ticks (effect A); tempo (effect T) sets the duration of one tick. At 125 BPM and speed 6, one row takes 120 ms and one tick 20 ms. Songs play patterns in a cue sequence; effects B and C navigate this sequence.

## 6. Default parameters at song start

| Parameter | Value |
|---|---|
| Speed | $06 (6 ticks/row) |
| Tempo byte | $64 (125 BPM; see effect T for the $19 offset) |
| Global volume | $80 (mid-scale) |
| Channel volume | $3F (full) |
| Note volume | $3F (full; reseeded from instrument's Default Note Volume on every re-trigger) |
| Channel pan (all channels) | $80 (centre) |
| Note pan | $00 offset (neutral; reseeded from the instrument's Default Pan or its Ixmp zone's on a re-trigger that carries one) |
| cue index | $0000 |

## 7. Effect memory groups

Most effects recall their last non-zero argument when re-issued with $0000. Unlike ST3, which shares one memory slot across most effects, Taud groups memories into four cohorts plus private slots:

- **E and F share one slot** (pitch slide down and up). Issuing E $0000 recalls the last E-or-F argument and re-applies it as a down-slide; F $0000 does the same as an up-slide.
- **G has its own slot** (tone portamento).
- **H and U share one slot** (vibrato speed and depth are jointly recalled; the last-written values persist across both commands).
- **R has its own slot** (tremolo).

Every other memory-carrying effect (D, I, J, K, L, N, O, P, Q, and others) has a private slot.

**Effects without recall (literal zero).** A few effects do *not* recall on $0000 — the argument **MUST** be taken at face value. **M** (set channel volume), **V** (set global volume), and the volume- / panning-column SET selectors all behave this way: writing `M $0000` or `V $0000` is a literal "set to silence", not a memory recall. Converters lifting from source trackers that *do* share memory (notably ST3, where the `$00` argument may cohabit with D/E/F/etc.'s shared slot) **MUST** eagerly resolve the recall to an explicit value before emitting, since the Taud engine takes M / V arguments verbatim.

## 8. Opcode and argument format

Opcodes are single base-36 digits (0-9, then A-Z); arguments are 16-bit hexadecimal values prefixed with `$`. A cell is notated `OPCODE $HHLL` where HH is the high byte and LL is the low byte. Where an effect partitions its argument into sub-fields (for instance, H's speed and depth), the split is spelled out in the command description.

The base-36 space (`$00`…`$23`) is fully assigned. An effect introduced after it filled lives in a second, ASCII-symbol space instead: on-disk opcode bytes `$A0`…`$FE` decode as `opcode − $80`, the effect's own ASCII character — `:` is `$3A`, so its on-disk opcode is `$BA`. An editor renders such an opcode as that character, exactly as it renders a base-36 opcode as its digit or letter; nothing else about the format changes.

# The effects

## A $xx00 — Set tick speed to $xx

**Plain.** Sets how many ticks each row contains. Lower values make rows shorter and per-tick effects (slides, vibrato) develop faster; higher values stretch the row and give effects more iterations.

**Compatibility.** ST3 `Axx` maps one-to-one: Taud `A $xx00`. ST3 `A00` is a no-op; Taud `A $0000` is likewise ignored. ProTracker `Fxx` with `xx < $20` maps to Taud `A $xx00`; `Fxx` with `xx ≥ $20` maps to T instead (see T).

**Implementation.** If the high byte is non-zero, the engine **MUST** write it to `ticks_per_row`; the low byte is reserved and **MUST** be zero. The change takes effect from the row on which the A command appears. There is no memory for A.

## B $xxyy — Jump to cue $xxyy

**Plain.** Finishes the current row, then continues playback at row 0 of the pattern at cue position $xxyy. Use this to create song-level jumps, loops, or branching structures.

**Compatibility.** ST3 `Bxx` jumps to an 8-bit cue and maps to Taud `B $00xx`. The extended 16-bit range means Taud songs **MAY** have up to $10000 cue entries.

**Implementation.** On the last tick of the current row, the engine **MUST** set the next cue index to the argument and the next row to 0. If the argument exceeds the song length, the engine **MUST** wrap to the song's defined restart position (cue $0000 by default). Jumps **SHOULD** be detected by a visited `(cue, row)` set so that pathological loops do not prevent song-length computation, though they **MUST NOT** interrupt actual playback. There is no memory for B.

**Simultaneous B and C on the same row.** If a B command appears in the same row as a C command (on any channel), both **MUST** fire: B chooses the cue, C chooses the row within that cue. If the two commands appear on different channels, channel priority is **ascending channel index** — the lowest-numbered channel carrying either effect wins its parameter. If both appear on the same channel row (only possible if one is a volume-column equivalent), the effect column **MUST** take precedence.

## C $xxyy — Break pattern to row $xxyy

**Plain.** Finishes the current row, then skips ahead to row $xxyy of the **next** pattern in the cue sequence.

**Compatibility.** ST3 stores `Cxx` as **BCD** (so on-disk `$10` means decimal row 10); Taud stores the argument as plain binary. When converting from ST3, converters **MUST** decode with `row = (byte >> 4) × 10 + (byte & $0F)`. Valid ST3 source bytes are those representing decimal 0..63; out-of-range BCD bytes **SHOULD** clamp to row 0 on import. When exporting back to ST3, converters **MUST** encode with `byte = ((row / 10) << 4) | (row % 10)`, clamped at row 63.

**Implementation.** On the last tick of the current row, the engine **MUST** advance the cue index by 1 (or honour a co-occurring B), then set the next row to the argument. If the argument exceeds the destination pattern's row count, the engine **MUST** start the destination pattern at row 0. There is no memory for C.

## D $xy00 — Volume slide (multiple forms)

D's 16-bit argument encodes four mutually exclusive modes using the top nibble and the following byte. **All forms operate on `note_vol`** (the per-note axis described in §3, analog of IT `chan->volume`) and clip to $00..$3F after each step. The slid value persists into following rows until the next re-trigger; `channel_vol` is **not** touched by D — for the per-channel axis, use N.

### D $0y00 — Volume slide down by $y per non-first tick

**Plain.** Each tick after tick 0, `note_vol` decreases by $y. A D $0400 at speed 8 reduces volume by $1C over the row.

**Compatibility.** ST3 `Dx0` (volume slide down) maps to Taud `D $0x00`. The ST3 volume cap was $40; Taud's is $3F — a very high-volume sample reaching $40 in ST3 will snap to $3F in Taud.

**Implementation.** On ticks > 0, subtract the low nibble of the high byte from `note_vol`; clamp at $00; mirror `row_vol = note_vol`. Memory is private to D and is keyed on the full original byte (so D $0000 recalls whatever form last ran).

### D $x000 — Volume slide up by $x per non-first tick

**Plain.** Each tick after tick 0, `note_vol` increases by $x. Capped at $3F.

**Compatibility.** ST3 `D0y` (volume slide up) maps to Taud `D $y000`.

**Implementation.** On ticks > 0, add the high nibble of the high byte to `note_vol`; clamp at $3F; mirror `row_vol = note_vol`.

### D $Fy00 — Fine volume slide down by $y on tick 0

**Plain.** Applies a one-shot `note_vol` reduction of $y on tick 0 only. Independent of speed. A D $FF00 behaves as a fine slide up by $F (so a request for "down by F" is reinterpreted; see below).

**Compatibility.** ST3 `DFy` maps directly. The $FF edge case is preserved: ST3 treats `DFF` as fine slide up by $F rather than fine slide down by $F, and Taud follows suit.

**Implementation.** On tick 0 only, subtract the low nibble of the high byte from `note_vol`; mirror `row_vol = note_vol`. If the low nibble is $0, treat as fine-slide-up by $F. If the high byte is $FF, treat as fine-slide-up by $F.

### D $xF00 — Fine volume slide up by $x on tick 0

**Plain.** One-shot `note_vol` increase of $x on tick 0 only.

**Compatibility.** ST3 `DxF` maps directly. Volume cap is $3F, lower than ST3's $40.

**Implementation.** On tick 0 only, add the high nibble to `note_vol`; clamp at $3F; mirror `row_vol = note_vol`.

## E $xxxx — Pitch slide down by $xxxx

**Plain.** Lowers the channel's pitch by the argument per tick. The coarse argument has **three distinct interpretations** chosen by the song-table `ff` field (effect `1`, bits 1-2):

- **Linear mode** (`ff = 0`, default): the argument is a value in the 4096-TET pitch grid, subtracted directly from the stored pitch. `E $0155` ≈ one semitone per tick.
- **Amiga (cycle-based) mode** (`ff = 1`): the argument is a **raw ProTracker/ST3 period unit count** — the same byte the original tracker stored on disk, *unscaled*. The engine converts the channel's stored 4096-TET pitch back to an Amiga period, subtracts the argument from that period directly, then converts the result back to 4096-TET. `E $0001` therefore corresponds to PT `201` and produces the characteristic non-linear pitch drift of ProTracker-style slides (lower pitches drift more slowly in semitone terms than higher pitches).
- **Linear-frequency mode** (`ff = 2`): the argument is **Hz/tick** at A4 = 440 Hz / C4 ≈ 261.6256 Hz reference. The engine converts the stored pitch to audible frequency, subtracts the argument from that frequency, then converts the result back to 4096-TET. `E $0010` is the verbatim Monotone `210` (drop 16 Hz/tick); the slide produces a constant *frequency* delta per tick, so the perceived semitone drop is larger at low pitches and smaller at high pitches — exactly Monotone's tracker semantics.

Because Amiga period units (and Monotone Hz/tick) fit in a single byte (PT/ST3 max value $FF, MONOTONE max $3F), the coarse range never approaches the $F000 fine-slide marker, so the same argument-format selector still distinguishes coarse from fine across all three modes. **Fine slides (`E $Fxxx`) follow the same mode-selection rule as coarse**: linear mode reads the low 12 bits as 4096-TET units, Amiga mode reads them as raw tracker period units, and linear-frequency mode reads them as Hz. A coarse slide uses the full value range; a fine slide applies only once per row.

Coarse and fine modes are distinguished by the high nibble of the argument:

- `E $0001..$EFFF` — coarse slide: subtracts the full argument from pitch each tick after tick 0. A slide of $0155 drops pitch by one semitone per tick.
- `E $F000..$FFFF` — fine slide: on tick 0 only, subtracts `arg & $0FFF` from pitch.
- `E $0000` — recalls the last E-or-F argument and applies it as a down-slide, preserving the original form (coarse or fine).

**Compatibility.** ST3 pitch slides operate on Amiga periods or linear slide units; Taud's storage depends on the song-table mode flag:

- **Linear-source ST3 song** (`linear_slides` set in S3M flags → Taud `ff = 0`):
  - ST3 `Exx` coarse (where `xx < $E0`) → Taud `E round($00xx × 64/3)` (1 ST3 coarse unit = 1/16 semitone = 64/3 ≈ 21.33 Taud units, rounded).
  - ST3 `EFx` fine → Taud `E $F0 round(x × 16/3)` (1 ST3 fine unit = 1/64 semitone = 16/3 ≈ 5.33 Taud units, applied once per row).
  - ST3 `EEx` extra-fine → Taud `E $F0 round(x × 16/3)` (same unit as fine, applied once per row).

- **Amiga-source ST3/PT song** (`linear_slides` clear → Taud `ff = 1`):
  - ST3 `Exx` coarse / PT `2xx` → Taud `E $00xx` **verbatim**, with no `× 64/3` scaling. The engine reads the stored byte as Amiga period units and applies it in period space, recovering the original tracker's exact period-step count.
  - ST3 `EFx` fine / `EEx` extra-fine / PT `E2x` → Taud `E $F00x` **verbatim** (raw period-unit nibble in the low 4 bits), with no `× 16/3` scaling. The engine performs the once-per-row fine slide in Amiga period space, mirroring the coarse arithmetic.

- **MONOTONE source** (Taud `ff = 2`):
  - MONOTONE `2xx` → Taud `E $00xx` **verbatim** (Hz/tick). The engine converts the stored pitch to frequency, subtracts the argument, and converts back. MONOTONE has no fine-slide form; converters never emit `E $Fxxx` for ff=2 sources.

The mode flag therefore controls **two** decoder behaviours simultaneously: (a) which numeric scale the converter ought to have used when emitting coarse arguments, and (b) which arithmetic the engine performs on those arguments per tick. Converters **MUST** set bits 0-1 (`ff`) of the song-table flags byte to match the units they emit, and **MUST NOT** mix scales within one Taud song.

Because E and F share memory in Taud (narrower than ST3's broad shared memory), an ST3 song that used `E00` or `F00` to recall a D, G, or Q argument will break on import; the converter **MUST** eagerly resolve ST3 recalls into explicit Taud arguments rather than relying on memory.

**Implementation.** Per-tick processing:

```
on row start:
    raw = arg
    if raw == 0: raw = memory_EF
    else: memory_EF = raw
    if (raw & $F000) == $F000:          # fine, applied once on tick 0
        mag = raw & $0FFF
        if   tone_mode == 1:            # Amiga: mag is raw period units; pitch down ⇒ +period
            pitch = amiga_slide_down(pitch, mag)
        elif tone_mode == 2:            # linear-freq: mag is Hz/tick; pitch down ⇒ −freq
            pitch = linear_freq_slide(pitch, −mag)
        else:                            # linear: mag is 4096-TET units
            pitch -= mag
        mode_this_row = FINE
    else:                                # coarse
        slide_amount_this_row = raw
        mode_this_row = COARSE

on tick > 0:
    if mode_this_row == COARSE:
        if   tone_mode == 1:
            # slide_amount_this_row is a raw tracker period-unit count (no × 64/3 scaling).
            # period = AMIGA_BASE_PERIOD × 2^(−(pitch − C4) / 4096)
            # period_new = period + slide_amount_this_row     # E subtracts pitch ⇒ adds period
            # pitch = C4 + 4096 × log2(AMIGA_BASE_PERIOD / period_new)
            pitch = amiga_slide_down(pitch, slide_amount_this_row)
        elif tone_mode == 2:
            # slide_amount_this_row is Hz/tick (verbatim from MONOTONE 2xx).
            # freq = LINEAR_FREQ_C4_HZ × 2^((pitch − C4) / 4096)
            # freq_new = max(freq − slide_amount_this_row, 1)
            # pitch = C4 + 4096 × log2(freq_new / LINEAR_FREQ_C4_HZ)
            pitch = linear_freq_slide(pitch, −slide_amount_this_row)
        else:
            pitch -= slide_amount_this_row
```

Glissando control (S $1x) snaps the output pitch to the nearest semitone after every slide application; see S $1x.

## F $xxxx — Pitch slide up by $xxxx

**Plain.** Raises the channel's pitch by the argument per tick, with the same mode-selection scheme as E. Coarse, fine, memory behaviour, and Amiga / linear-freq mode handling are identical in form but inverted in direction. The same triple-interpretation rule applies to **both** coarse and fine arguments: 4096-TET units in linear mode, raw tracker period units in Amiga mode, Hz/tick in linear-frequency mode.

**Compatibility.** Same as E. In linear-source songs, ST3 `Fxx` coarse converts using `round(x × 64/3)` and `FFx`/`FEx` fine/extra-fine use `round(x × 16/3)`. In Amiga-source songs (PT or S3M with `linear_slides` clear), both forms are stored verbatim: `Fxx` coarse → `F $00xx`, and `FFx`/`FEx` fine/extra-fine / PT `E1x` → `F $F00x`. In MONOTONE-source songs (ff=2), `1xx` → `F $00xx` verbatim (Hz/tick); MONOTONE has no fine-slide form. F and E share one memory slot in Taud. Slide-mode behaviour is controlled by the same `ff` field as E; under any non-linear mode, both coarse (per-tick) and fine (tick-0 only) F slides are applied in the corresponding mode's space.

**Implementation.** As for E, but add instead of subtract. No upper pitch cap is defined by the effect itself, but the sample-rate conversion at the mixer will saturate well before arithmetic overflow at reasonable playing ranges.

## G $xxxx — Tone portamento with speed $xxxx

**Plain.** Slides the channel's current pitch toward the note specified in the same row, at $xxxx units per tick (after tick 0), stopping when the target is reached. A row with G and a note does **not** re-trigger the sample — the note's pitch becomes the portamento target and the already-sounding sample continues at its current pitch.

The unit of `$xxxx` depends on the song-table tone mode (effect `1`, bits 0-1):

- `ff = 0` (linear) and `ff = 1` (Amiga): 4096-TET pitch units per tick. Amiga sources **SHOULD** be converted to linear units on G, since the original PT G slide already operated semi-linearly within a small range and the shared-memory pitfall of E/F does not apply here.
- `ff = 2` (linear-frequency): Hz/tick. The engine walks the channel's *frequency* toward the target note's frequency by `±$xxxx` Hz each non-first tick. This is MONOTONE's `3xx` behaviour verbatim (MTSRC/MT_PLAY.PAS:620-630).

**Compatibility.** ST3 `Gxx` uses an 8-bit value in period-table units; converters **MUST** convert to Taud using the same `round(× 64/3)` scale as E/F coarse (1/16 semitone per ST3 slide unit). Amiga-mode G sources **SHOULD** be treated as linear. MONOTONE `3xx` → Taud `G $00xx` verbatim under ff=2. G has its **own** memory slot in both ST3 and Taud, so conversion is straightforward and does not suffer the shared-memory problem of E/F.

**Implementation.**

```
on row parse:
    if row has note and G effect:
        target_pitch = pitch_for(note)
        # do NOT re-trigger sample
    if arg != 0:
        memory_G = arg
    speed_this_row = memory_G

on tick > 0 (linear / Amiga modes):
    if target_pitch set:
        delta = sign(target_pitch - pitch) × speed_this_row
        pitch += delta
        if sign crossed target: pitch = target_pitch; target_pitch = None

on tick > 0 (linear-frequency mode):
    if target_pitch set:
        target_freq = LINEAR_FREQ_C4_HZ × 2^((target_pitch − C4) / 4096)
        cur_freq    = cached freq (or recomputed from pitch on first use)
        cur_freq   += sign(target_freq − cur_freq) × speed_this_row
        if sign crossed target_freq: cur_freq = target_freq; target_pitch = None
        pitch = C4 + 4096 × log2(cur_freq / LINEAR_FREQ_C4_HZ)
```

Glissando (S $1x) snaps the output frequency to the nearest semitone ($0155 step approximation) after each advance without changing the internal pitch counter; it affects only what the mixer sees.

## H $xxyy — Vibrato with speed $xx and depth $yy

**Plain.** Modulates pitch with a low-frequency oscillator (LFO). `$xx` is the LFO speed (high byte), `$yy` is the depth (low byte). On H rows the LFO accumulator advances at `$xx` per tick through a 1088-step lookup of the selected waveform (see S $3x). The current pitch offset is added to the channel's base pitch for the duration of each tick.

**Compatibility.** ST3 `Hxy` uses 4-bit nibbles for speed and depth; convert by nibble-repeating each into Taud's bytes: ST3 `H27` → Taud `H $2277`. This preserves both exactly: the phase is 1088 steps precisely so that the nibble-repeat's factor of 17 divides out, and a converted LFO walks the same waveform entries on the same ticks as the tracker it came from (TAUD_ENGINE_SPEC.md §6.2). Converters **MUST NOT** scale the speed byte any other way — `x << 4` and friends are 6% off and the exactness is free. H and U share memory in Taud (they did in ST3 too).

Unlike ProTracker, ST3 vibrato fires on tick 0 as well; Taud follows ST3.

**Implementation.** The reference sine table is OpenMPT's 64-entry 8-bit table, indexed `⌊pos ÷ 17⌋` through a 1088-step logical LFO (equivalently, a 1088-sample 17×-oversampled sine peaking at ±$7F). The 1088 steps, rather than the 256 a 4-bit-speed tracker uses, are what let the 8-bit speed byte cover the same rate range 17× more finely *and* land exactly on the source's rate under nibble-repeat — see TAUD_ENGINE_SPEC.md §6.2:

```
ModSinusTable[64] =
    00 0C 19 25 31 3C 47 51 5A 62 6A 70 75 7A 7D 7E
    7F 7E 7D 7A 75 70 6A 62 5A 51 47 3C 31 25 19 0C
    00 F4 E7 DB CF C4 B9 AF A6 9E 96 90 8B 86 83 82
    81 82 83 86 8B 90 96 9E A6 AF B9 C4 CF DB E7 F4
```

Per row/tick:

```
on row parse (H):
    if (arg >> 8)  != 0: memory_HU.speed = arg >> 8
    if (arg & $FF) != 0: memory_HU.depth = arg & $FF

on every tick (including tick 0):
    sine = ModSinusTable[lfo_pos ÷ 17]            # signed -$80..+$7F
    pitch_delta = (sine × memory_HU.depth) >> 6
    applied_pitch = base_pitch + pitch_delta
    lfo_pos = (lfo_pos + memory_HU.speed) mod 1088
```

At maximum speed and depth ($FFFF), peak `pitch_delta` is `$7F × $FF >> 6 ≈ $1FA` — about 1.5 semitones. On a fresh note, if the current LFO waveform retrigger bit is clear (S $3x with $x < $4), `lfo_pos` resets to 0. When the waveform is "random", a fresh random value is drawn every tick rather than read from the table.

## U $xxyy — Fine vibrato with speed $xx and depth $yy

**Plain.** Same LFO as H but four times finer in pitch — useful for subtle microtonal warbles.

**Compatibility.** ST3 `Uxy` uses nibbles; nibble-repeat each to convert. U shares memory with H.

**Implementation.** Identical to H except the shift is 8 instead of 6:

```
pitch_delta = (sine × memory_HU.depth) >> 8
```

Peak at maximum settings: $7F × $FF >> 8 ≈ $7E, about 0.4 semitone — exactly a quarter of H's peak.

## I $xxyy — Tremor with on-time $xx and off-time $yy

**Plain.** Rapidly gates the channel on and off. Volume plays normally for `$xx + 1` ticks, then mutes for `$yy + 1` ticks, repeating. Counters persist across rows and only reset on a fresh I row with a new argument.

**Compatibility.** ST3 `Ixy` uses nibbles (`$xy`) with the same semantics; convert by nibble-repeating each into Taud bytes: ST3 `I47` → Taud `I $4477`. The `+1` behaviour on both counters comes from ProTracker and is preserved throughout. Memory is private.

**Implementation.**

```
on row parse (I):
    if arg != 0: memory_I = arg
    on_time  = ((memory_I >> 8)  & $FF) + 1
    off_time = ( memory_I        & $FF) + 1

on every tick:
    if phase == ON:
        play at the unmodulated row_vol (no gating)
        tick_in_phase += 1
        if tick_in_phase >= on_time: phase = OFF; tick_in_phase = 0
    else:
        row_vol = 0          # transient gate; note_vol / channel_vol are preserved
        tick_in_phase += 1
        if tick_in_phase >= off_time: phase = ON; tick_in_phase = 0
```

The OFF-phase gate writes `row_vol` only; `note_vol` and `channel_vol` are untouched, so the per-row rebase (`row_vol = note_vol` at row start) restores the audible level cleanly when tremor stops.

A zero `$xx` or `$yy` input becomes 1 tick after the `+1`, never zero.

## J $xxyy — Microtonal arpeggio with offsets $xx00 and $yy00

**Plain.** Cycles the playing pitch through three values across consecutive ticks: the note, the note plus `$xx00` Taud units, and the note plus `$yy00` Taud units, repeating. At the default 50 Hz tick rate (speed 6, 125 BPM), this produces a classic chord-arpeggio effect; because Taud's grid is 4096-TET, the intervals can be microtonal.

The encoding places each 8-bit offset byte into the **high byte** of a 16-bit pitch delta, giving 256 discrete intervals per arp voice with a resolution of $0100 ≈ 0.75 semitone per step. This is coarser than E/F's 16-bit slides, but adequate for arpeggios and well-suited to non-12-TET intervals.

**Compatibility.** ST3 `Jxy` uses nibbles as 12-TET semitones; Taud uses bytes as $0100-scaled 4096-TET offsets. The conversion is therefore lossy — 12-TET intervals that are not multiples of 3 semitones incur ±25 cent rounding error. The table below gives the best Taud byte for each 12-TET semitone offset:

| Semitones | Taud byte | Taud units | Error (cents) |
|---|---|---|---|
| 0 | $00 | 0 | 0 |
| 1 | $01 | 256 | −25 |
| 2 | $03 | 768 | +25 |
| 3 | $04 | 1024 | 0 |
| 4 | $05 | 1280 | −25 |
| 5 | $07 | 1792 | +25 |
| 6 | $08 | 2048 | 0 |
| 7 | $09 | 2304 | −25 |
| 8 | $0B | 2816 | +25 |
| 9 | $0C | 3072 | 0 |
| 10 | $0D | 3328 | −25 |
| 11 | $0F | 3840 | +25 |
| 12 | $10 | 4096 | 0 |

For example, ST3 `J37` (minor chord) imports as Taud `J $0409`; ST3 `J47` (major chord) as Taud `J $0509`. Memory is private and stores the full 16-bit argument.

**Implementation.**

```
on row parse (J):
    if arg != 0: memory_J = arg
    off1 = (memory_J >> 8) & $FF    # high byte
    off2 =  memory_J       & $FF    # low byte

on every tick:
    selector = tick_within_row mod 3
    if selector == 0:   voice_pitch = base_pitch
    elif selector == 1: voice_pitch = base_pitch + (off1 << 8)
    elif selector == 2: voice_pitch = base_pitch + (off2 << 8)
```

The `tick_within_row mod 3` counter resets every row start (so every row begins at `base_pitch`). A subsequent E/F slide after a J row resumes from the last arpeggiated voice's pitch, not from `base_pitch` — this mirrors ST3's `kST3PortaAfterArpeggio` quirk and is deliberately preserved.


**Extended (paired with `:`).** `J $xxxx : $yyyy` replaces the two <<8-scaled BYTE offsets above with two full 16-bit 4096-TET offsets: `off1` is J's own argument verbatim, `off2` the paired `:`'s argument verbatim, order-independent as every pairing is. Where the base form reaches 256 discrete intervals at $0100 ($0100 ≈ 0.75 semitone) per step, the extended form reaches the full 65536-step resolution E and F already have — arpeggios can be as microtonal as any other pitch effect. Memory is private and separate from the base form's (the two are different units, so a row using one form **MUST NOT** recall the other's last value): `off1` recalls when J's own argument is `$0000`, `off2` when the paired `:`'s argument is `$0000`, independently.

## K $xy00 — Dual: vibrato continuation and volume slide $xy

**Plain.** Continues the previously started vibrato (H or U) without retriggering it, while applying a volume slide of `$xy` per non-first tick. Fine volume slides are not available in this form. The K command is implemented solely for tracker compatibility — new compositions **SHOULD** prefer an explicit `H $0000` (vibrato recall) plus a volume-column slide (`1.$xy` / `2.$xy`), which carries the same semantics with one less hidden dependency.

**Compatibility.** ST3 / IT `Kxy` map directly to Taud `K $xy00`: the source's `xy` argument byte goes verbatim into the high byte of the Taud argument. ProTracker / FT2 / XM `6xy` map identically. Source-tracker memory cohorts that share K's argument with D (notably the ST3 single-slot shared memory and IT's D/K/L vol-slide cohort) **MUST** be resolved eagerly by the converter — converters **MUST** emit explicit arguments rather than relying on cohort sharing, since Taud's K has its own private slot.

**Implementation.** On row parse:

```
on row parse (K):
    raw = (arg >> 8) & $FF                 # the xy nibble pair lives in the high byte
    if raw == 0: raw = memory_K
    else: memory_K = raw
    voice.vibratoActive = true              # H/U speed and depth come from memory_HU
    hi_nib = (raw >> 4) & $F
    lo_nib = raw & $F
    # Slide direction: high nibble = up, low nibble = down. Both non-zero ⇒ down wins (ST3 quirk).
    if hi_nib != 0 and lo_nib == 0:
        slide_per_tick = +hi_nib
    elif lo_nib != 0:
        slide_per_tick = -lo_nib
    else:
        slide_per_tick = 0

on every tick (including tick 0):
    apply vibrato update with memory_HU.speed / memory_HU.depth (see §H)

on tick > 0:
    note_vol = clamp(note_vol + slide_per_tick, 0, $3F)
    row_vol  = note_vol
```

The slide writes the per-note axis (same as D); `channel_vol` is untouched. K has its own memory slot (private). The slide always uses the per-tick form — `K $FF00` does **not** trigger a fine slide; the argument's `$F` nibbles are interpreted as `$F`-magnitude per-tick slides (down wins), matching ST3's K and IT's K semantics.

## L $xy00 — Dual: tone portamento continuation and volume slide $xy

**Plain.** Continues the previously started tone portamento (G) without retriggering, while applying a volume slide of `$xy` per non-first tick. Fine volume slides are not available here. Like K, L is implemented solely for tracker compatibility — new compositions **SHOULD** prefer an explicit `G $0000` plus a volume-column slide.

**Compatibility.** ST3 / IT `Lxy` map directly to Taud `L $xy00`. ProTracker / FT2 / XM `5xy` map identically. As with K, source cohort recalls (ST3 shared memory; IT D/K/L vol-slide cohort) **MUST** be resolved eagerly by the converter; Taud's L has its own private slot.

**Implementation.** Identical machinery to K with `G` swapped for the LFO update:

```
on row parse (L):
    raw = (arg >> 8) & $FF
    if raw == 0: raw = memory_L
    else: memory_L = raw
    # Tone portamento target is set by the row's note (see §G); G's stored speed (memory_G) drives the slide.
    hi_nib = (raw >> 4) & $F
    lo_nib = raw & $F
    if hi_nib != 0 and lo_nib == 0:
        slide_per_tick = +hi_nib
    elif lo_nib != 0:
        slide_per_tick = -lo_nib
    else:
        slide_per_tick = 0

on tick > 0:
    apply tone-portamento step using memory_G.speed (see §G)
    note_vol = clamp(note_vol + slide_per_tick, 0, $3F)
    row_vol  = note_vol
```

The slide writes the per-note axis (same as D); `channel_vol` is untouched. L has its own memory slot (private), separate from K's and from D's.

## M $xx00 — Set channel volume to $xx

**Plain.** Sets the per-channel volume axis (`channel_vol`, see §3) to `$xx`, in the same 6-bit `$00..$3F` range as a note's default volume. M is the analog of IT's `Mxx`, which writes `chan->global_volume` — it does **not** disturb the per-note volume (`note_vol`) set by the volume column or seeded from the instrument default. A vol-col SET of $02 on a note row followed by an `M $4000` on the next row therefore plays the channel at `2/63 × $3F/63 ≈ 3%` of full, *not* at full — exactly as IT would.

**Compatibility.** IT `Mxx` maps directly: the source byte **MUST** be taken **verbatim** with a clamp to `$3F` (IT's $40 cap snaps down by one). ST3 has no native M; OpenMPT/Schism's S3M-with-IT-extensions does, and the same verbatim-with-clamp rule applies on import. M has **no memory** — `M $0000` is a literal "set channel volume to silence", not a recall. Source-tracker shared-memory recalls (e.g., ST3's single-slot shared memory) **MUST** be eagerly resolved by the converter before emit.

**Implementation.**

```
on row parse (M):
    new_vol = (arg >> 8) & $FF
    if new_vol > $3F: new_vol = $3F
    channel_vol = new_vol
    # note_vol and row_vol are NOT touched. The mixer multiplies channel_vol
    # into the per-voice gain via the volume-ramp target, so the change is
    # heard from this tick onwards without nuking the per-note volume.
```

The change takes effect on tick 0 of the row (the next mixer ramp window picks it up). There is no slide form; for that, use N. The low byte of M's argument is reserved.

## N $xy00 — Channel volume slide

**Plain.** Slides the per-channel volume axis (`channel_vol`, see §3 and §M) by `$xy` per non-first tick (or once on tick 0 for fine forms). Encoding is identical to D (see §D), but the slide acts on `channel_vol` — independent of `note_vol`, so vol-col SET / D-slide state on the per-note axis survives across an N. The change persists into following rows that don't reissue N. Range and clipping match D: `$00..$3F`.

**Compatibility.** IT `Nxy` maps directly to Taud `N $xy00` (high byte = source argument byte, verbatim). ST3 has no native N. N's encoding sub-forms mirror D exactly:

- `N $0y00` — coarse slide down by `$y` per non-first tick.
- `N $x000` — coarse slide up by `$x` per non-first tick.
- `N $Fy00` — fine slide down by `$y` on tick 0 only (with the same `$FF` "fine up by $F" quirk as D).
- `N $xF00` — fine slide up by `$x` on tick 0 only.

**Memory.** N has its own private slot, separate from D's. `N $0000` recalls the last N argument and re-applies it in its original sub-form (coarse vs fine, up vs down).

**Implementation.** Identical to D, with `channel_vol` substituted for `note_vol`. After every step the result is clamped to `$00..$3F`. `note_vol` and `row_vol` are **not** touched — the mixer multiplies `channel_vol` into the per-voice gain via the volume-ramp target, so the change is heard within the row without disturbing the per-note baseline:

```
on row parse (N):
    raw = (arg >> 8) & $FF
    if raw == 0: raw = memory_N
    else: memory_N = raw
    decode raw exactly as D does (FF / F0 / Fy / xF / 0y / x0 → fine-up-F / coarse / fine forms)
    schedule per-tick (or apply once) on channel_vol — never touch note_vol / row_vol
```

## P $xy00 — Channel panning slide

**Plain.** Slides the channel's persistent pan by `$xy` per non-first tick (or once on tick 0 for fine forms). Encoding is layered on D's structural skeleton, but the *direction* of each nibble follows the IT panning convention: the low nibble of the high byte slides **right**, the high nibble of the high byte slides **left**. Pan ranges over the full 8-bit space (`$00`..`$FF`, $80 centre); P writes the persistent `channel_pan` so the change persists across rows. It is the CHANNEL axis's slide, the twin of N on the volume side — the panning column's own slide selectors move `note_pan` (§3a), and an engine **MUST** keep the two per-tick accumulators separate so a P and a column slide running together move both axes.

In surround mode the pan runs right round the listener, so a slide WRAPS at the ends instead of clamping: sliding right past $1FF continues at $000. Where an interpolation has a target (effect `Z`), the path taken is the shorter of the two ways round; if the start and target directions are antipodal, the interpolation path **MUST** be clockwise.

**Compatibility.** IT `Pxy` maps directly to Taud `P $xy00` (high byte = source argument byte, verbatim). ST3 has no native P. The four sub-forms are:

- `P $0y00` — slide right by `$y` per non-first tick.
- `P $x000` — slide left by `$x` per non-first tick.
- `P $Fy00` — fine slide right by `$y` on tick 0 only.
- `P $xF00` — fine slide left by `$x` on tick 0 only.

The `$FF` corner case (`P $FF00`) follows the D / N quirk: it is interpreted as "fine slide left by `$F`" (the high-nibble form wins when both nibbles are `$F`).

**Memory.** P has its own private slot, separate from D / N. `P $0000` recalls the last P argument and re-applies it in its original sub-form.

**Implementation.**

```
on row parse (P):
    raw = (arg >> 8) & $FF
    if raw == 0: raw = memory_P
    else: memory_P = raw
    hi_nib = (raw >> 4) & $F
    lo_nib = raw & $F
    if raw == $FF or (hi_nib == $F and lo_nib == 0): apply fine-left-by-F on tick 0
    elif hi_nib == $F and lo_nib != 0:                apply fine-right-by-lo_nib on tick 0
    elif lo_nib == $F and hi_nib != 0:                apply fine-left-by-hi_nib on tick 0
    elif hi_nib == 0 and lo_nib != 0:                  per-tick: channel_pan += lo_nib (right)
    elif lo_nib == 0 and hi_nib != 0:                  per-tick: channel_pan -= hi_nib (left)

on every per-tick or fine step:
    channel_pan = clamp(channel_pan ± step, 0, $FF)
    row_pan     = channel_pan >> 2     # 6-bit pan value used by the mixer
```

The mixer reads `channel_pan` (8-bit) through the same path as `S $80xx`, and sums it with `note_pan` and the pan envelope (§3a). P slides interact additively with panbrello (Y) and with the panning column's slide selectors, the latter now by way of the other axis rather than by sharing the register.

## O $xxxx — Set sample offset to $xxxx

**Plain.** On the row where it appears, jumps the sample playhead to byte $xxxx of the sample data. If the sample is looped and the requested offset exceeds the loop end, the offset wraps around through the loop as if playback had reached that point naturally.

**Compatibility.** ST3 `Oxx` is 8-bit, addressing offset `xx × $100`. On import, copy the ST3 byte into Taud's high byte and zero the low byte: Taud `O $xx00`. ProTracker `9xx` maps identically. The Taud 16-bit form allows byte-precise seeking within samples larger than $100 bytes. Memory is private.

**Implementation.** On the row start, set the sample playhead to `arg` (in bytes, relative to the sample's start). Apply the loop-wrap calculation if the sample has loop points and `arg > loop_end`: `arg = loop_start + ((arg - loop_start) mod loop_length)`. The O command does not retrigger the sample; it only relocates the playhead for an already-triggered note.


**Extended (paired with `:`).** `O $abcd : $efgh` combines both arguments into a 32-bit offset, `$abcdefgh` — O's own argument is the HIGH word, the paired `:`'s the LOW word — reaching samples past the 64 KB the base form's 16 bits address. Loop-wrap and the rest of the base form's behaviour are unchanged, just against the wider value. An implementation **MUST** combine the two arithmetically (`high × 65536 + low`, or the 64-bit-widened equivalent) rather than with a 32-bit shift-and-OR: shifting a 16-bit value 16 bits left overflows a 32-bit SIGNED integer the moment its top bit is set, in Kotlin's `Int` as much as in a JS bitwise op. Memory is private and separate from the base form's 16-bit one (same reasoning as J's), recalling the last 32-bit value when the combined argument is `$00000000`.

## Q $xy00 — Retrigger note every $y ticks with volume modifier $x

**Plain.** Retriggers the currently playing sample at an interval of `$y` ticks, optionally modifying its volume on each retrigger according to `$x`. The retrigger interval runs across rows until a new Q with a different `$y` or no Q at all.

**Compatibility.** ST3 `Qxy` maps directly. The **`$y == 0` behaviour is preserved from ST3**: the entire effect is ignored (no retrigger, and memory is not updated). Memory is private.

ProTracker `E9x` is equivalent to Taud `Q $0x00` (retrigger only, no volume change).

**Implementation.** A per-channel tick counter advances every tick, including tick 0. When it reaches `$y`, the sample retriggers (keeping current pitch), the counter resets to 0, and the volume modifier `$x` applies to `note_vol` (the per-note axis — IT's `chan->volume`). `channel_vol` is untouched. The counter resets only when a row has **no** Q command; successive Q rows share and advance the counter.

The volume modifier table, **computed with arithmetic (no LUT)**, is:

| $x | Action | $x | Action |
|---|---|---|---|
| 0 | no change | 8 | no change |
| 1 | vol − $01 | 9 | vol + $01 |
| 2 | vol − $02 | A | vol + $02 |
| 3 | vol − $04 | B | vol + $04 |
| 4 | vol − $08 | C | vol + $08 |
| 5 | vol − $10 | D | vol + $10 |
| 6 | vol × 2 / 3 | E | vol × 3 / 2 |
| 7 | vol × 1 / 2 | F | vol × 2 |

Multiplicative cases **MUST** use integer arithmetic: `vol × 2 / 3` is `(vol × 2) / 3` (truncated); `vol × 3 / 2` is `(vol × 3) / 2`; `vol × 1 / 2` is `vol >> 1`; `vol × 2` is `vol << 1`. All results **MUST** clip to $00..$3F after.

A note previously silenced by a cut (`^^^` or `SCx` earlier in the row) **MUST NOT** be retriggered, matching ST3's `kST3RetrigAfterNoteCut` rule.

**Metainstruments.** A metainstrument is ONE note, so it retriggers whole: every layer-child voice on the channel **MUST** restart with the foreground voice — sample position, all four envelope playheads, fadeout and filter history — on the same tick. The volume modifier `$x` belongs to the channel and is applied **once**, on the foreground voice; the per-tick parent sync then carries the new `note_vol` to the children. Restarting layer 0 alone leaves it stuttering over a remainder that sustains, which is not a retrigger of anything a listener can hear as one sound.

## R $xxyy — Tremolo with speed $xx and depth $yy

**Plain.** Modulates volume with an LFO, symmetrically with H's pitch modulation. `$xx` is LFO speed, `$yy` depth; the waveform is selected by S $4x.

**Compatibility.** ST3 `Rxy` uses nibbles; converters **MUST** convert by nibble-repeat, which reproduces ST3's oscillator exactly — see H. ST3's volume cap is $40; Taud's is $3F — very deep tremolo that would have briefly clipped at $40 in ST3 **MAY** clip slightly earlier in Taud. R has its own memory slot (not shared with H/U).

**Implementation.** Identical machinery to H with a larger shift to fit the narrower volume range:

```
on row parse (R):
    if (arg >> 8)  != 0: memory_R.speed = arg >> 8
    if (arg & $FF) != 0: memory_R.depth = arg & $FF

on every tick (including tick 0):
    sine = ModSinusTable[lfo_pos ÷ 17]
    vol_delta = (sine × memory_R.depth) >> 9
    row_vol = clamp(note_vol + vol_delta, 0, $3F)        # modulate around the per-note axis
    lfo_pos = (lfo_pos + memory_R.speed) mod 1088
```

The LFO bias is added to `note_vol` (per-note axis, mirroring IT's tremolo on `chan->volume`) and the result lands in `row_vol`, never written back into `note_vol` itself — so the row-end rebase reseats `row_vol` cleanly and tremolo dies on the next row without leaving residue. `channel_vol` is unaffected.

Peak at maximum settings: $7F × $FF >> 9 = $3F — the full volume range. Retrigger behaviour tracks the S $4x waveform nibble bit 2: cleared means retrigger on new note, set means preserve LFO position.

## T $xxyy — Tempo set or tempo slide

Taud splits T by which byte carries the value:

### T $xx00 (high byte non-zero) — Set tempo

**Plain.** Sets the Taud tempo byte to `$xx`. The resulting BPM is `$xx + $19`: Taud byte $00 → 25 BPM, $64 → 125 BPM (default), $FF → 280 BPM.

**Compatibility.** ST3 `Txx` (where `xx ∈ $20..$FF`) stores BPM directly; converters **MUST** convert with `taud_byte = xx − $18`. Taud byte $07 corresponds to ST3's minimum BPM of 32; Taud bytes below $07 are inexpressible in ST3 and **SHOULD** round up to $07 (BPM 32) when exporting. OpenMPT's extended tempo slides (`T $0x` down, `T $1x` up) in S3M files map to Taud T $00xx — see below.

ProTracker `Fxx` with `xx ≥ $20` maps to Taud `T $(xx − $19)00`; `Fxx` with `xx < $20` maps to A (speed) instead.

**Implementation.** If the high byte is non-zero, set `tempo_byte = arg >> 8`; derive `BPM = tempo_byte + $19`; compute tick duration as `samples_per_tick = rate × 5 / (BPM × 2)`, i.e. `80000 / BPM` (integer truncated) at the 32000 Hz reference rate. Example at that rate: BPM 125 → 640 samples per tick; BPM 24 → 3200 samples per tick; BPM 280 → 286 samples per tick. There is no memory for set-tempo.

### T $FFxx (high byte 0xFF) — Set tempo (extended)

**Plain.** Sets the Taud tempo byte to `$FF + $xx`. The resulting BPM is `$xx + $118`: xx = $00 → 280 BPM, $64 → 380 BPM, $FF → 535 BPM.

**Compatibility.** Unique to Taud.

### T $00xy (high byte zero) — Tempo slide

**Plain.** Adjusts the tempo continuously during the row. `$00_0y` (low nibble under a zero high nibble within the low byte) slides BPM down by `$y` per non-first tick; `$00_1y` slides up. Out-of-range encodings ($00_20 through $00_FF) are reserved and behave as no-ops.

**Compatibility.** ST3 itself has only the set form; the slide forms originate in the OpenMPT/Schism extension of S3M. On export to strict ST3, slide forms are unrepresentable and **SHOULD** be approximated as an equivalent set-tempo on a later row.

**Implementation.**

```
on row parse (T with high byte == 0):
    low = arg & $FF
    if (low & $F0) == $00:
        slide_dir = DOWN
        slide_amount = low & $0F
    elif (low & $F0) == $10:
        slide_dir = UP
        slide_amount = low & $0F
    else:
        ignore row

on tick > 0 (if slide armed):
    if slide_dir == DOWN: tempo_byte = max($00, tempo_byte - slide_amount)
    else:                 tempo_byte = min($FF, tempo_byte + slide_amount)
    recompute samples_per_tick for next tick
```

A tempo slide's memory slot is separate from the set-tempo path and is private to T-slide.

## V $xx00 — Set global volume to $xx

**Plain.** Sets the global mix bus volume (0..$FF). $00 is silence; $FF is full. The default is $80.

**Compatibility.** ST3's global volume is 0..$40; converters **MUST** convert with `taud_v = st3_v × 4`, clamped at $FF. On export, `st3_v = taud_v >> 2`, clamped at $40. IT's global volume is 0..$80; converters **MUST** convert with `taud_v = it_v × 2`, clamped at $FF. On IT, the very first `V 00` command **MUST** be resolved as the song's initial global volume.

**Implementation.** The engine **MUST** write the high byte to `global_volume` on the row the command appears. The low byte is reserved. ST3's `kST3NoMutedChannels` rule applies: V on a muted channel is ignored by ST3; for strict-compatible playback Taud **MUST** follow suit, but new Taud compositions **SHOULD NOT** mute channels that carry global effects.

## W $xy00 — Global volume slide

**Plain.** Similar to `D $xy00`, but applies to the global volume.

**Compatibility.** IT `Wxy` maps directly.

**Implementation.** See effect D, apply to the global volume instead.

## Y $xxyy — Panbrello (panning vibrato) with speed $xx and depth $yy

**Plain.** Modulates panning with an LFO, symmetrically with H's pitch modulation. `$xx` is LFO speed, `$yy` depth; the waveform is selected by S $5x.

**Compatibility.** IT `Yxy` uses nibbles; converters **MUST** convert by nibble-repeat, which reproduces IT's oscillator exactly — see H. IT's panning cap is $40 and Taud pans on $00…$FF, so a converted `Yxy` sweeps the same fraction of the stereo field; where IT clipped at its cap, a stereo song saturates at the ends of the summed pan and a surround song turns past them. Y has its own memory slot.

**Implementation.** Identical machinery to H, producing a **signed pan offset** rather than a write to either pan axis. The mixer sums it with `channel_pan` and `note_pan` (§3a, TAUD_ENGINE_SPEC.md §10.3), which is what lets the LFO swing around wherever the channel and the note have already put the voice — an instrument's zone pan keeps its position and gets modulated, instead of being overwritten — and is what carries Y into the surround models unchanged:

```
on row parse (Y):
    if (arg >> 8)  != 0: memory_Y.speed = arg >> 8
    if (arg & $FF) != 0: memory_Y.depth = arg & $FF

on every tick (including tick 0):
    if panbrello is active for this row:
        sine = ModSinusTable[lfo_pos ÷ 17]
        panbrello_offset = (sine × memory_Y.depth) >> 7
        lfo_pos = (lfo_pos + memory_Y.speed) mod 1088
    else:
        panbrello_offset = 0
```

The `else` branch is where a row without `Y` puts the voice back on its base pan, and it **MUST** live in the tick pass rather than the per-row reset. A row boundary runs the row pass *after* the tick pass, so an offset cleared by the row pass is still cleared while the new row's first tick renders — which drops one tick of dead centre into the middle of every sweep held across rows. Peak at maximum settings: $7F × $FF >> 7 = $FE — the full panning range, so the deepest settings drive the sum into the clamp at both ends. An NNA ghost freezes at the offset it carried out of the channel; a metainstrument's layer children follow their parent's offset, exactly as they follow its pan. Retrigger behaviour tracks the S $5x waveform nibble bit 2: cleared means retrigger on new note, set means preserve LFO position.

## 2 $sexy and 3 $sexy — Sample modification

**Plain.** One command with two spellings: it applies a running, non-destructive modification to part of a sample. `3` names the region to **modify**; `2` names the region to **leave alone** and modifies everything else. Otherwise they are identical.

| nibble | meaning |
| --- | --- |
| `$s $e` | the region — see *The region argument* below |
| `$x` | the operation (below); `$0` switches the modification off |
| `$y` | the step period in **ticks**: `$F` every tick, `$1` every fifteenth, `$0` frozen |

Operations:

| `$x` | operation |
| --- | --- |
| `$0` | off / reset |
| `$1` | invert loop — invert one more byte of the region per step |
| `$2` `$3` `$4` `$5` | rotate the region's bytes **left** by 1 / 2 / 4 / 8 bytes per step |
| `$6` `$7` `$8` `$9` | subtract 2 / 8 / 32 / 128 from every byte of the region per step, wrapping through zero |
| `$A` `$B` `$C` | **jump**: move the whole region to a new random offset each step, drawn uniformly from the whole domain — `$A` lands on a whole **eighth** of it, `$B` lands on a **sixteenth**, `$C` anywhere |
| `$D` `$E` `$F` | **scatter**: shuffle the region, throwing every byte its own way, within 1/512th / 1/64th / 1/8th of the wrap domain |

There is no rotate-right: rotating left by `n` and right by `span − n` are the same picture, and the ladder buys more spent on step sizes.

**Everything is measured against the loop region.** The command's **domain** is the sounding voice's loop when it has one and the whole sample when it does not, and every selector, every comb, every wrap and every jump quantum is a fraction of THAT — never a raw byte count, never the base record's loop. So one argument means the same musical thing on every instrument it is pointed at, an Ixmp-patched voice follows its own loop, and `$A`'s eighths are eighths of the bar the loop holds rather than of the file that contains it. The domain test is the Engine Specification §8.4's: an instrument whose loop points are empty has the whole sample as its domain, which is also why `$00` and `$0F` name the same span.

`$A`…`$F` are the same address transform driven by chance instead of by a step, and they split on **what the throw applies to**. A **jump** (`$A`…`$C`) draws ONE offset and moves the whole region by it, so the waveform arrives intact somewhere else — the sound survives, its place in the sample does not. A **scatter** (`$D`…`$F`) draws a separate offset **for every byte**, so the region is shuffled rather than moved.

All three jumps reach the whole domain and differ in **grain**: `$A` quantises the throw to eighths of the domain, `$B` to sixteenths, `$C` not at all. On a loop cut to the bar that is the difference between a beat repeat and a glitch — an eighth is a musical distance, so `$A` and `$B` land where a hit starts and the loop comes back re-ordered but still in time, while `$C` lands mid-transient as readily as on one. Eighths suit a backbeat and sixteenths anything busier; between them they cover most of what a bar is written in.

The scatter ladder splits instead on **spread**, and it is short on purpose: `$D` (a 512th of the domain) roughens the waveform, `$E` (a 64th) breaks it up, `$F` (an eighth) is as far as the ladder goes. Past an eighth the bytes a throw lands among have nothing to do with the ones it left, the interpolator averages strangers, and every wider setting arrives at the same quiet white noise — a different effect, and not an interesting one. Kept near home the throw is a glitch **in** the waveform rather than a replacement for it. Nothing accumulates in either family: every step measures from the sample's real position, which is what stops `$D` from drifting into `$F` after a few seconds.

`$y` is a **period in ticks**, not a divisor: `16 − $y`, so `$F` steps every tick, `$E` every other one, `$8` every eighth and `$1` every fifteenth. `$y = 0` **freezes** the modification where it is and keeps everything it has accumulated. `$x = 0` is the reset — the operation, the region and the accumulated state all go.

ProTracker's funk-speed ladder (the table `S $F0xx` and `Z $Ffxx` share) does **not** apply here. That table is an accumulator divisor: `EFx` had to fit its timing into a running sum, which buys an uneven ladder whose steps land where the arithmetic puts them rather than where the bar does. Nothing in this command needs that compromise, and `$A` is worth little without exact timing — a randomised drum loop has to re-deal itself ON the tick grid or it is not in time. `S $F0xx` keeps the historical ladder, because it is ProTracker's effect.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent, and no converter emits either opcode. `S $F0xx` remains the ProTracker-compatible invert loop and is a **separate, independent** modification: it keeps its own loop-region mask, and a song that never writes `2` or `3` **MUST** render exactly as it did before these effects existed.

**Implementation.** An instrument carries **one** modification — writing either opcode replaces it — and the state splits the way `S $F0xx`'s does: the modification belongs to the **instrument** (every channel sounding it hears the same sample) and the clock driving it to the **channel**. Nothing is ever written to the sample pool; the operation is applied as bytes are read.

**Metainstruments.** A metainstrument is one note made of several instruments, so the command **MUST** be written to all of them: the foreground layer's instrument plus every layer child's. The clock stays one per channel per DISTINCT instrument — two layers of a kit that sound the *same* instrument **MUST NOT** step it twice a tick, or a stacked unison walks the modification at double speed while a plain note of the same instrument walks it at the written one.

```
the domain, per sounding voice:
    if loop_end > loop_start:  domain = [loop_start, loop_end)
    else:                      domain = [0, sample_length)
    extent = domain_start + round(domain_length × from) …
             domain_start + round(domain_length × to)     # from/to are $se
    wrap   = the extent for effect 3, the whole domain for effect 2

on every tick (when an operation is selected and $y != 0):
    if ++mod_tick_count >= 16 - $y:
        mod_tick_count = 0
        step the operation once (below)

on sample byte read at position i:
    if the modification TOUCHES i (extent, comb and $2's inversion):
        ROL/JUMP: read from  wrap_start + ((i - wrap_start + rot) mod wrap_length)
        SCATTER:  read from  wrap_start + ((i - wrap_start + throw(i)) mod wrap_length)
                  where throw(i) is i's OWN offset, uniform over ±reach
        INVERT: invert the byte when mod_mask[i] is set
        SUB:  byte = (byte - sub) AND $FF
```

- **INVERT** keeps a bit-mask one bit per **sample** byte (not per domain byte: an inverted region's touched set is not a contiguous span, so there is no smaller origin to index from). Each step walks the write position to the next byte the region touches and flips it. An engine **MUST** bound that walk — an inverted region can exclude nearly the whole domain, and the search for the one byte left over must not become the tick's cost. The reference engine scans at most 4096 positions and otherwise lets the step not land.
- **ROL** accumulates a byte displacement. Its step is an absolute byte count, the one thing in the command that is not a fraction — it is a grain size, not a place.
- **SUB** accumulates a subtrahend modulo 256, so `$9` (128) inverts the level on odd steps and restores it on even ones, while `$6` (2) crawls.
- **JUMP** is ROL with a thrown step: one offset for the whole region, drawn **uniformly** over the domain and wrapped into it. `$A` and `$B` **MUST** quantise the draw to a whole multiple of `round(domain_length ÷ {8,16})` — eight/sixteen outcomes, `0` (stay home) among them — while `$C` draws any byte position. Rounding rather than truncating the slice matters: on a domain of 1000 the slice is 125 and the eighth boundary is where it should be, where `⌊1000 ÷ 8⌋` would put every slice a little short of it and the error would grow across the domain. It **MUST NOT** accumulate — each step's offset is measured from the region's real position, not added to the last one. Every byte moves together, so the waveform is intact when it lands; this is a randomised `O $xxyy`, once a step, and it is the one random operation that leaves the instrument recognisable.
- **SCATTER** shuffles. Every byte of the region **MUST** be displaced *independently*, each by its own offset uniform over `±round(domain_length × fraction)` and wrapped into the domain — moving the region as a block is the rotation, not this. The draw **MUST** be uniform over that range: a bell was tried and reverted, because leaving most bytes at home and flinging a few reads as noise mixed under the sample rather than as the sample breaking up. The offsets **MUST NOT** accumulate either: each step measures from the byte's ORIGINAL position, which is what keeps `$D` inside its 512th of the domain however long the effect runs, and what keeps the three settings three settings rather than the same random walk arriving at different speeds.
- A scatter's offset **MUST** be a pure **function of the byte's index** within a step, not a value pulled from a stream as bytes are read. One output sample reads the same position through every interpolator tap and through both channels of a stereo sample, and a fresh draw per read would smear every setting into the same white noise. The reference engine therefore draws ONE 32-bit seed per step and hashes it with the byte index (a murmur3-style finaliser); the seed comes from the same RNG as volume and pan swing, so a scatter is the one modification a replay does not reproduce byte-for-byte. A **permutation is not required** — a byte may be drawn twice and another not at all. Requiring one would mean shuffling an index table the size of the sample on every step, and it is not audible at this grain.
- A scatter is read back through the **normal interpolator**, exactly as if the shuffled bytes had been written into the pool. Where the reach is small next to the sample's own period the neighbouring reads stay correlated and the result is the same note with a rougher waveform; where it approaches that period they stop correlating, the interpolator averages bytes that no longer agree, and the result loses level as it loses shape. That is what fixes the top of the ladder at an eighth of the domain — far enough to hear the sample come apart, not so far that every setting past it is the same noise. Both ends are correct; neither is to be compensated for in the engine.
- **A step is crossfaded, not cut.** Replacing an address or level mapping in one sample is a discontinuity, and at `$y = $F` that is one per tick — which is what the clicking is. An engine **SHOULD** ease each step in: the reference engine reads both mappings for **64 output samples** (2 ms at 32 kHz) and mixes them on a linear weight, which costs one extra pool read per tap over that window and leaves the effect its bite. INVERT is exempt — one flipped byte is not a discontinuity. **Changing or clearing** the command is not covered either, and is not meant to be: that is a deliberate edit, like a note cut.
- Changing the operation, the region or the inversion **MUST** discard whatever the previous operation accumulated and restart the walk — a rotation offset means nothing to a subtract. Re-stating the **same** command row after row **MUST NOT** restart anything, or a command repeated down a pattern would never get past its first step.
- Every `$x` nibble carries an operation, but a reserved REGION is still ignored **whole**, speed included, so a typo cannot drive a modification the writer never named.
- The modification is **runtime state**: it persists across rows and patterns within one playback, is **NOT** reset by a fresh note trigger (it is sample state, not note state), and **MUST** be cleared on cue-start reset alongside the invert mask.

### The region argument ($se, effects 2 and 3)

The region byte's two nibbles are read as a **from/to pair covering the whole domain** while `s <= e`, and as a **selector** when `s > e`. Every row of this table is a fraction of the domain, never of the file:

| `$se` | region |
| --- | --- |
| `$00` | the whole loop region — the same span as `$0F`, and the spelling to write when the loop is the point |
| `$se`, `s <= e` | from `s/16` to `(e+1)/16` of the domain — so `$0F` is all of it and `$4B` the middle half |
| `$10` | the middle half |
| `$20` / `$21` | the first two thirds / the last two thirds |
| `$30` / `$31` / `$32` | the first / middle / last third |
| `$F0`…`$FE` | **comb, even bristles**: cut the extent into `2^(n+1)` equal chunks and keep the 0th, 2nd, 4th… — `$F0` is the first half, `$F1` touches `1-3-` of four, `$FE` is 32768 bristles |
| `$E0`…`$ED` | **comb, odd bristles**: the same cut keeping the 1st, 3rd, 5th… — `$E0` is the second half, `$E1` touches `-2-4` |
| `$40`…`$DD` where `s > e` | reserved |

Notes an engine **MUST** honour:

- Region ends are **rounded** to the nearest byte, from the fraction — an engine that stores byte offsets instead of fractions will disagree the moment an Ixmp patch moves the loop under a sounding voice.
- `$00` is the loop region **as the sounding voice sees it**: an Ixmp patch brings its own loop points, and the region follows them rather than the base record's. So does everything else in the table.
- The two comb ladders stop where they do because `$FF`, `$EE` and `$EF` have `s <= e` and are already ordinary extents (the last sixteenth, the fifteenth, the last eighth). That is why the odd ladder is one rung shorter than the even one.
- A comb selector leaves the extent alone, so `3 $311F` followed by `3 $F21F` combs the middle third into eight. The extent and the comb are independent halves of one region, and the comb divides **the extent**, not the domain. Writing a new extent clears the comb: a region written from scratch is written solid.
- A comb finer than its extent is not an error. The chunks fall below a byte and the ladder ends where it began historically — every other byte, give or take.
- The inversion of effect `2` applies to the region **and** its comb: `2 $F01F` is the second half of whatever extent is standing. It does **not** reach outside the domain: `2` spares its region and modifies the rest of the LOOP, not the rest of the file.

### Why sample mods and why more of them

**Invert Loop** is a deliberately unusual effect inherited from the ProTracker tradition. The original Funk Repeat manipulated the playback loop itself — Taud keeps that one too, under its own opcode, as `Z $Ffxx` — while ProTracker 1.1B and everything after it used `E $Fx` for Invert Loop, progressively modifying samples within the loop.

Its practical musical value was never obvious, and that is precisely why it survived in tracker folklore. Composers such as *4mat* demonstrated that effects which initially appeared useless could become distinctive musical techniques when placed in the right hands.

**Sample Subtraction** subtracts a controlled value from the sample waveform during playback, producing an evolving change in its harmonic structure.

This technique has historical precedent in Konami's MSX-era sound design, where waveform manipulation of the SCC's wavetable was used to create evolving timbres, including a characteristic "growing" sawtooth-like sound whose harmonic content shifts toward an octave-up character.

**Sample Jump** is the one to reach for first, because it is the one that keeps the instrument. Every step the whole region moves to a new random offset — measured from where it really sits, never added to the last throw — and because every byte moves *together*, what arrives is the sample intact, playing from somewhere else. A looped instrument becomes a machine that re-deals which part of itself it is looping, on the beat, without ever ceasing to sound like itself.

That is **Paula**, and it is the oldest trick on the machine. Paula had no playback engine to speak of — a start pointer, a length, and DMA that fetched words until the loop came round — so everything the Amiga's composers did to a note already sounding was done by writing those registers underneath it. ProTracker's `9xx` — the effect this format spells `O $xxyy` — is exactly that: a read-head jump handed to the effect column, and one of the most productive commands in the tradition, because a sample cut at a different place is a different instrument for free. Jump is `9xx` given a die and a clock, and the three spellings are the dice. `$C` rolls anywhere in the sample. `$A` rolls one of **eight** and `$B` one of **sixteen**, quantised to whole eighths and sixteenths of the region — which is the difference between a beat repeat and a glitch, and the reason the family is worth three opcodes rather than one.

A drum loop is written to a bar. Cut that bar into eight and every boundary is where a hit starts, so `$A` on a one-bar loop can only ever land on a hit: what comes back is the loop with its slices re-dealt, still in time, still playing the same drums — a beat repeat that never repeats the same way twice, and one you can leave running under a whole section because it cannot drift out of the grid. `$B` cuts the same bar into sixteen, which is the grid a busier loop is actually written on — hi-hats, sixteenth-note funk, anything whose hits fall between the eighths `$A` can see. `$C` on the same loop lands mid-transient as readily as on one, and that is its own instrument: the loop coming apart rather than being re-ordered. Point any of them at something sustained instead of struck and the grid stops mattering — there the choice is just how coarse you want the re-seating to be.

**Sample Scatter** is the same idea refusing to stop. Every byte of the region is thrown its *own* way, by its own draw, and thrown again from where it belongs on the next step: `$D` keeps each within a 512th of the domain of home, `$E` within a 64th, `$F` within an eighth. The ladder ends at an eighth rather than at some tidier number because that is where the effect ends: throw a byte further than the waveform's own period and it lands among bytes that have nothing to do with it, so every wider setting is the same white noise at the same reduced level. Nothing accumulates here either, so it is not a slow slide into chaos but a chosen amount of it, held for as long as the command stands.

What that *sounds* like is decided by the throw against the sample's own period, and both ends are worth knowing before reaching for it. Throw a byte a short way on material whose waveform is slow next to the throw — a single-cycle wave, a low sustained tone — and the bytes it lands among are its near neighbours: the note keeps its pitch and its level and comes back with a rougher, dirtier waveform. Throw it across many cycles of the source and the bytes it lands among have nothing to do with it: what comes back is noise, several decibels quieter than the source, because the interpolator is averaging things that no longer agree. The three settings are the walk up to that edge, and stop at it.

The far end is **granular synthesis**, taken to the grain size this hardware actually has. A granular engine cuts a sample into grains and sprays their read positions around a playhead; the spray is the control that decides whether the result thickens the source or forgets it. Scatter is that control with the grain shrunk to a single byte — no windows, no envelopes, nothing to tune but how far — so what it sprays is not a cloud of recognisable fragments but the sample's own material re-dealt. `$F` is the honest end of that walk: far enough that the sample's own material is audibly re-dealt, close enough that it is still that sample's material and not the statistics of it. (A jump, by the same measure, is a granular engine with exactly one grain — which is why it stays musical where scatter goes to noise.)

The near end is **wavetable manipulation**, and it is the same idea Sample Subtraction is built on. Konami's SCC work rewrote the 32-byte table under a sounding note to make the timbre move; Subtraction does that to the table's *levels*, sliding every point down together. Scatter does it to the table's *order* — the cycle keeps its length, so the note keeps its pitch, and only the shape inside it is disturbed. Point `3 $0FDy` at a single-cycle waveform and that is exactly what you get: the same note, breaking up.

**The comb** is how a region stops being one place and becomes a *rate*. Every selector above cuts the sample somewhere; the comb cuts the cut, into `2` then `4` then `8` equal chunks and on down to 32768, and keeps every other one. At the coarse end that is an edit — `$F0` is the first half of the loop, `$E0` the second, and a pair of rows can hand a modification from one half of a bar to the other without touching the extent. Two or three rungs down, the chunks are shorter than a note and the alternation is heard as a texture rather than a place. At the fine end the chunks fall under a byte and the comb is the ProTracker artefact the ladder started from — every other byte, ring-modulating the sample against the sampling rate.

Because the ladder is written in **bristles** rather than in bytes, it means the same thing on every instrument: `$F2` is eight chunks of the loop whether the loop is 400 bytes or 40000, so a comb written against a drum loop keeps working when it is pointed at a pad. The even and odd spellings are the same comb read from the other side, which is what makes the pair worth having — `3 $F1xy` and `3 $E1xy` on two rows are the two halves of one gesture, and `2` inverts either.

**Clicks**, finally, are the tax on all of this, and they are paid at the step. Replacing an address mapping between one output sample and the next is a discontinuity by construction: a jump teleports the waveform, a scatter re-deals it, `$9` inverts its polarity. At `$y = $F` that happens every tick, which is what "sample mods click" has always meant. The engine crossfades each step over two milliseconds instead of cutting to it — long enough that the edge is gone, short enough that a beat repeat still lands on the beat. What remains is the effect's own seam, where the region wraps: that one is the modification, not an artefact of it, and it is left alone.

It may look strange compared with conventional effects such as chorus or phaser, but sample-domain manipulation is very much in the tradition of tracker and programmable-sound synthesis: the waveform itself becomes part of the instrument's performance. Between them the operations perform the three things a sample has — its **content** (Invert Loop flips the bytes), its **level** (Subtraction slides them) and its **order** (the rotations step it, Jump throws it whole, Scatter shuffles it apart) — with nothing written to the pool and nothing to undo when the song stops.


**Extended (paired with `:`).** `2 $sexy : $fuuk` and `3 $sexy : $fuuk` — `$se` is unchanged (the region, exactly as above); `$x` and `$y` no longer stand alone, each widened by nibbles borrowed from the paired `:`'s own argument `$fuuk`:

| Field | Width | Made of | Meaning |
|---|---|---|---|
| `$f` | 4 bit | `:`'s high nibble | a further sub-range on top of `$se`'s (below) |
| `$xuu` | 12 bit | `2`/`3`'s `$x` nibble, then `:`'s middle byte (`uu`) | the operation, replacing the base form's 4-bit `$x` |
| `$yk` | 8 bit | `2`/`3`'s `$y` nibble, then `:`'s low nibble (`k`) | the speed, replacing the base form's 4-bit `$y` |

**`$f` — sub-range.** Narrows the extent `$se` already resolved, the same way `$se`'s own `$10`/`$20`..`$32` rows narrow the whole domain:

| `$f` | keeps |
|---|---|
| `$0` | no change |
| `$1` / `$2` | the left / right half of the extent |
| `$3` / `$7` / `$8` | the left / middle / right third |
| `$4` / `$5` / `$6` / `$9` | the leftmost / middle-right / middle (halves 2-3) / rightmost quarter |
| `$A` / `$B` | alternates the extent's two halves, one step at a time — `$A` opens on the first half, `$B` on the second |
| `$C` / `$D` | alternates the extent's odd/even quarters (chunks 1+3 vs 2+4) the same way, `$C` opening on 1+3 |
| `$E` | keeps 4 of every 8 BYTES (`1234----`), independent of the extent's own length |
| `$F` | keeps every other BYTE (`1-3-5-`), independent of the extent's own length |

`$A`..`$D`'s alternation advances once per STEP of the operation (the same clock `$yk` drives) — a byte the region touches this step may not be touched the next, which is what makes the pair a texture rather than a fixed edit. `$1`..`$9` and `$E`/`$F` are static and do not depend on the step count. Every `$f` value is ANDed with `$se`'s own extent-and-comb test: a byte must clear both to be touched.

**`$xuu` — operation, 0x000..0xFFF.** Replaces the base form's 16-entry `$x` table with a much wider one. Entries not listed are reserved (treated as `$100`, no-op):

| Code | Operation |
|---|---|
| `$100` | no-op |
| `$101` | invert loop — the base form's `$1`, bit-flip one byte per step |
| `$102` | funk repeat — the resolved region stands in for `Z $Ffxx`'s own declared loop (its length is the hop, "add replen to repeat"), walked through the WHOLE PHYSICAL SAMPLE exactly as `Z` searches past its loop for room — NOT bounded to the region the way ROL/JUMP/SCATTER are, clocked by THIS command instead |
| `$103` | simply invert — XORs the WHOLE touched region by `$FF` every step (a toggle, not a walk) |
| `$104` | reverse — mirrors the touched region's byte order, toggled every step |
| `$11x` | invert loop, jittered: the walk's next byte is offset by a random throw instead of always "the next one", reach ±100/2^(15−x) % of the domain |
| `$12x` | funk repeat, jittered the same way |
| `$13x` / `$14x` | quantised random jump to 1/N of the region, N indexed by `x` from {2,3,4,5,6,7,8,9,10,12,15,16,18,21,24,32} — `$13x` and `$14x` are the same operation under this command's architecture, which already scopes every address transform to `$se`'s resolved extent; see the implementation note below |
| `$15x` | a BOUNDED jump — thrown to within ±1/N of the region rather than quantised to a slice, N from the same table |
| `$160` | randomly swap one byte pair within the region, per step |
| `$161`..`$16F` | scatter, 16 levels from 1/16384 of the domain up to the whole domain ("fully"), finer than the base form's 3-level `$D`/`$E`/`$F` |
| `$2xx` | rotate the region left by `xx` BYTES per step (a direct count, not the base form's 1/2/4/8 ladder) |
| `$3xx` | rotate right by `xx` bytes — new; the base form has no rotate-right |
| `$4xx` / `$5xx` | rotate left / right by `xx × 256` bytes |
| `$6xx` / `$7xx` | subtract / add `xx` per step (a direct value, not the base form's 2/8/32/128 ladder) — accumulates the same way the base form's SUB does, wrapping through zero |
| `$8xx` | XOR by `xx` per step — new; accumulates by XOR |
| `$90x` / `$91x` | rotate the BITS (not bytes) of every touched byte left / right by `x`, accumulating mod 8 |
| `$920`..`$927` | bitwise NOT / reverse-bits / swap-nibbles / swap-twobits and their compositions (below) |

`$920`..`$927`'s eight codes are three involutions (reverse the 8 bits; swap the two nibbles; swap each adjacent bit pair) and their compositions:

| Code | Byte `abcdefgh` becomes |
|---|---|
| `$920` NOT | `~abcdefgh` |
| `$921` reverse | `hgfedcba` |
| `$922` swap nibbles | `efghabcd` |
| `$923` reverse, then swap nibbles | `dcbahgfe` |
| `$924` swap twobits | `badcfehg` |
| `$925` reverse, then swap twobits | `ghefcdab` |
| `$926` swap nibbles, then swap twobits | `fehgbadc` |
| `$927` all three (they commute) | `cdabghef` |

Unlike a bit-ROTATE, each of these is its own inverse — applying one twice restores the original byte — so a conforming implementation **MUST** treat a step on `$920`..`$927` (and `$103`/`$104`, the same shape) as a TOGGLE: the permutation is either applied to every touched byte or it isn't, and a step flips which. Applying it every step accumulating would just be applying it once, on every OTHER step.

**`$yk` — speed, 0x00..0xFF.** Replaces the base form's 4-bit `$y` (a period in whole ticks, `16 − y`) with a two-digit period in TICKS that can fall UNDER one:

| `$y` | period (ticks) |
|---|---|
| `$0` | `$00` = stop (frozen); `$0k`, k≠0 = `k/16` |
| `$1`..`$E` | `y + k/16` — the same linear formula, continued |
| `$F` | a separate, coarser ladder for periods past the fine ladder's ~15-tick reach: `$F0`=15, `$F1`=16, `$F2`=18, `$F3`=20, `$F4`=22, `$F5`=24, `$F6`=28, `$F7`=32, `$F8`=36, `$F9`=40, `$FA`=44, `$FB`=48, `$FC`=52, `$FD`=56, `$FE`=60, `$FF`=64 |

Because `$yk` can be UNDER one tick, an engine **MUST** clock this command at output-sample resolution rather than once per whole tick (unlike the base form): accumulate output samples against `period_ticks × samples_per_tick`, recomputed every sample the way the row/tick clock itself is (a mid-row tempo change retimes both together), and step when the accumulator crosses it. The reference implementation gives each extended voice its own such accumulator (`src/engine/tick.js` `advanceSampleModExtended`, driven from `src/engine/mixer.js`'s per-sample render loop) rather than reusing the base form's per-tick one.

**Implementation notes, and where this deliberately simplifies.**

- `$xuu`, `$yk` and `$f` together replace the base form's `$x` and `$y` for the SAME instrument slot — an instrument still carries only one modification, extended or not, and writing one form clears the other's accumulated state exactly as writing a new base-form operation does.
- `$13x` ("no domain restriction") and `$14x` ("restricted to `$se`+`$f`") are specified as distinct, but this command's own architecture already resolves every address transform against `$se`'s extent (the base form's ROL/JUMP/SCATTER never reach outside it either) — so under this implementation the two codes behave identically. An implementation with a genuinely wider addressing model **MAY** distinguish them; this one does not, and documents the fold rather than leaving it silent.
- The anti-click crossfade (base-form §"A step is crossfaded, not cut") carries over for the operations that replace a whole address or level mapping the same way ROL/JUMP/SCATTER/SUB do: `$2xx`..`$5xx`, `$13x`..`$15x`, `$161`..`$16F`, `$6xx`..`$8xx`. It does **NOT** cover the single-byte-flip and toggle families (`$101`/`$11x` invert, `$102`/`$12x` funk, `$103`/`$104`/`$920`..`$927` toggles, `$160` swap, `$90x`/`$91x` bit-rotate) — none of these replace a whole mapping the way a click-worthy step does; the base form's own INVERT is exempt for the same reason.
- `$102`/`$12x` (funk repeat) walk this command's OWN clock and OWN grid, independent of `Z $Ffxx`'s per-channel one — the two are separate modifications (as the base form's `$1` invert-loop is separate from `S $F0xx`), do not share state, and MAY run on one voice at once (this command's own window is what the voice sounds when they do). Unlike every other `$xuu` code, this one is NOT bounded to `$se`'s resolved extent: the resolved region stands in for `Z`'s own declared loop, so the walk searches the whole physical sample past it exactly as `Z`'s does, using the region's length as the hop. Neither exposes its own hop selector the way `Z`'s `$f` nibble does; the reference implementation walks at the grid's smallest hop, always forward.

## 5 $xxyy and 6 $xxyy — Filter Cutoff/Resonance Control

**Plain.** `5` sets the cutoff and `6` sets the resonance of the instrument's filter directly. When the filter is in ImpulseTracker mode, only the high byte (the `xx` part) is read; when the filter is in SoundFont2 mode, both bytes are read. Argument `$FFFF` resets the parameter to its default value (for both IT and SF2 mode). Every note that shares the instrument is affected — the change is **instrument-wide**, not per-voice. If cutoff vibrato is what you are after, modify the filter envelope directly.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent. The effect has **no memory** (`$0000` is a literal "set to zero", not a recall).

**Implementation.** The effect writes a per-instrument **cutoff / resonance override** that supersedes the value loaded from the instrument record (bytes 182/183, plus 252/253 in SF mode). The argument is decoded in the instrument's active filter mode:

- **ImpulseTracker mode:** only the high byte `$xx` is read (0..254 active; 255 = filter off), matching the 8-bit cutoff/resonance storage.
- **SoundFont2 mode:** the full 16-bit argument `$xxyy` is read (cutoff in absolute cents, resonance in centibels), matching the 16-bit storage.
- **`$FFFF`** clears the override, restoring the value loaded from the record. The engine **MUST** test for `$FFFF` *before* the mode split, so it is always the reset sentinel regardless of filter mode.

Because the override is instrument-wide, an engine **MUST** apply it to **every note that is already sounding** on that instrument — not only to notes triggered afterwards. The reference engine does this in two parts: (a) it stores the override on the instrument so subsequent triggers seed from it, and (b) it walks the live foreground voices and background ghosts and re-seeds the cutoff/resonance of every voice bound to the affected instrument, forcing a filter-coefficient refresh. A voice with a filter **envelope** recomputes its working cutoff from the (now-overridden) default each tick, so the envelope sweep is rescaled to the new base; a voice without one reads the overridden value directly.

This effect applies to ordinary instruments. When used on a **metainstrument**, the override **MUST** be applied to the constituent instruments all at once — the reference engine fans the write out across the foreground layer plus every layer-child voice sounding on the channel, so the whole stack moves together.

The override is **runtime state**: it persists across rows and pattern boundaries within one playback, but **MUST** be cleared when the song is restarted (so a loop or replay begins from the file defaults) and when a fresh instrument record is uploaded into the slot.

## 7 $xxyy — Pattern Ditto

**Plain.** A per-channel "fill the rest from above" marker: the engine copies the **$xx rows immediately preceding this cell on the same channel** and pastes them $yy times starting on this row. The destination block therefore covers `$xx × $yy` rows beginning at the ditto row inclusive. Any field (note, instrument, vol-column, pan-column, effect) that the composer has explicitly written into a destination row stays put and patches the corresponding field of the copied source cell — empty fields fall through to the source. The ditto opcode itself is consumed by the marker on its arming row; the rest of that row's columns are patched from the source as usual, so an empty arming row plays back identically to the first row of the source block.

For example, with `7 $1003` on row 16, rows 16..63 replay the contents of rows 0..15 three times. A `D $0400` punched onto row 22 simply overrides the effect column on that destination row; its note/vol/pan still come from the source row 6 (since (22 − 16) mod 16 = 6, and 0 + 6 = source row 6).

Boundary rules:

- The block stops at the end of the pattern: a ditto whose nominal span would overflow the pattern's row count clips silently at the final row.
- `$xx = $00`, `$yy = $00`, and any `$xx` greater than the row index on which the ditto sits are all treated as no-ops — there is nothing valid to copy from.
- A `7` cell appearing inside a source block is **not** recursively expanded: when that source row is pasted into a destination, its effect column is treated as empty. This keeps expansion single-pass and prevents unbounded nesting.
- Flow-control effects (B, C, `S $Bx`, `S $Ex`) that fall inside a source block still fire when their copy lands on a destination row, since the engine sees them as ordinary effect cells after expansion. Composers and converters **SHOULD NOT** place `S $Bx` loop bounds wholly inside a ditto'd range — the loop counter is per-voice and the same destination row would be revisited twice with the same state.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent. The effect has no memory.

**Implementation.** Per-voice state, all reset on pattern change alongside the existing pattern-loop / fine-pattern-delay clears:

- `dittoActive: bool`
- `dittoSourceStart: int` — first row of the source block (inclusive)
- `dittoLength: int` — $xx, the block size
- `dittoEndRow: int` — last destination row (inclusive)

At the very top of `applyTrackerRow`, before the per-voice reset of row-scope state, build an effective cell view for each voice:

```
raw = patternRows[V.pattern][N]                            # stored cell on row N for voice V
isArmer = (raw.effect == $7 and raw.effectArg != 0)

if isArmer:
    length  = (raw.effectArg >> 8) & $FF
    repeats =  raw.effectArg       & $FF
    if length > 0 and repeats > 0 and length <= N:
        V.dittoSourceStart = N - length
        V.dittoLength      = length
        V.dittoEndRow      = min(N + length * repeats - 1, patternLength - 1)
        V.dittoActive      = true
    # else: malformed argument — fall through with dittoActive unchanged

armRow = V.dittoSourceStart + V.dittoLength    # always equals the row that armed this ditto

if V.dittoActive and armRow <= N <= V.dittoEndRow:
    srcRow = V.dittoSourceStart + ((N - V.dittoSourceStart) mod V.dittoLength)
    src    = patternRows[V.pattern][srcRow]

    cell.note       = (raw.note != $0000) ? raw.note       : src.note
    cell.instrument = (raw.instrument != 0) ? raw.instrument : src.instrument

    # SEL_FINE / 0 is the canonical no-op encoding for the vol- and pan-columns;
    # any other (selector, value) pair is a write and patches the source.
    cell.vol, cell.volEff = (raw.volEff, raw.vol) != (SEL_FINE, 0)
                            ? (raw.vol, raw.volEff)
                            : (src.vol, src.volEff)
    cell.pan, cell.panEff = (raw.panEff, raw.pan) != (SEL_FINE, 0)
                            ? (raw.pan, raw.panEff)
                            : (src.pan, src.panEff)

    # On the armer row, the 7-opcode is consumed by the marker, so for effect-column
    # patching purposes the destination is treated as empty. Source 7-opcodes never
    # propagate (no recursive expansion).
    destOp, destArg = isArmer ? (0, 0) : (raw.effect, raw.effectArg)
    if destOp != 0:
        cell.effect, cell.effectArg = destOp, destArg
    elif src.effect != $7:
        cell.effect, cell.effectArg = src.effect, src.effectArg
    else:
        cell.effect, cell.effectArg = 0, 0

else:
    cell = raw
```

The four ditto fields are not cleared at the natural end of the destination range; they simply stop matching the gating condition once `N` advances past `dittoEndRow`, and a later armer cell in the same pattern overwrites them in place. Explicit clears happen only on cue advance (B / C / natural pattern end) and full playhead reset, alongside the existing pattern-loop counters in `resetPatternLoopState` / `resetParams`.

The rest of `applyTrackerRow` then dispatches on `cell` exactly as for an undittoed row — note triggering, vol/pan column application, and effect handling are unchanged. The expansion mutates the in-memory cell view only; the stored pattern data is never rewritten.

Pattern-delay (`S $Ex`) re-runs `applyTrackerRow` on the same `N` — the ditto bookkeeping is idempotent across those re-entries because `dittoActive`, `dittoSourceStart`, `dittoLength`, and `dittoEndRow` already encode the destination range, and the armer guard `length <= N` makes repeated arming on the same row a no-op (the new state is identical to the old). The `armRow <= N` half of the gating condition is what protects against an `S $Bx` pattern-loop that jumps back to a row sitting strictly before the armer: rather than synthesising from a phantom source slot, the engine falls through to the raw cell.

Effect dispatch sees the synthesised effect, never the literal `7` opcode of the armer cell — `OP_7` therefore exists in the engine's opcode table only as an explicit no-op for the rare malformed-armer fallthrough (`length == 0`, `repeats == 0`, or `length > N`).

## : $xxxx — Interrupt argument, and argument extension

**Plain.** `:` is not a command of its own — it is a 16-bit number that some OTHER part of its row reads. It has two readers, and the row's note column decides which one applies:

- On a row whose note column holds an **interrupt marker** (`Int0`…`IntF`, note words `$0010`…`$001F` — [File Format](TAUD_FILE_FORMAT.md#note-words), [Engine Spec §14](TAUD_ENGINE_SPEC.md#14-interrupts-and-the-host-interface)), `:` is **the interrupt's argument**: the 0…65535 the song hands to whatever program is playing it. This reading works in every format version.
- On any other row, `:` **extends** the argument of the effect sharing its row. That needs a row able to carry two effects at once — the wide cell of [file-format version 3](TAUD_FILE_FORMAT.md#5-5-format-version-3-the-wide-cell) — so in a version-1 or version-2 cell, or alone in a version-3 cell with nothing in the other slot, it is a well-formed but **inert** command, and a conforming engine **MUST** treat it as a no-op there, the same as an unrecognised opcode. `:` in **both** slots of such a row is likewise inert: there is nothing left for it to extend.

The two readings do not compete. `:` on an interrupt row that also sits beside a `J`, `O`, `2` or `3` is read by **both** — once as the interrupt's argument, once as that command's extension — because reading it does not consume it.

**Which slot.** As an extension, `:` is intended to sit in the row's second effect slot, the extended command in the first — `J $xxxx : $yyyy` — but a conforming engine **MUST NOT** depend on that order: `: $yyyy J $xxxx` means exactly the same thing. As an interrupt argument the slot does not matter either, and there is one rule for the one arrangement that has to resolve somehow: where **both** slots of an interrupt row hold a `:`, the engine **MUST** take the FIRST slot's argument and ignore the second's.

These spellings mean the same thing to the engine but not necessarily to a reader, so an editor **SHOULD** flag, by painting the whole 5-character cell in a distinct colour, every `:` whose argument nothing reads: `:` paired with a command that does not read its argument at all on a row that is not an interrupt row (a silent no-op), the second `:` of an interrupt row, and both of them where a non-interrupt row holds two. It **SHOULD** also flag the one arrangement a reader is most likely to misread even though the engine is happy with it — a `:` extending a command from the FIRST slot — along with the command it extends. A `:` that is doing a job, extending from the second slot or carrying an interrupt's argument from either, needs no flag and renders through its ordinary per-field colouring like any other row. The reference implementation is `src/ui/notenames.js` `fxColonWarns`, which returns one flag per slot, painting through `src/ui/glyphs.js` `paintFxCell` in red.

Only three commands currently define extended behaviour when paired with `:` — `J`, `O`, and `2`/`3`, each described under its own heading, in a subsection headed **Extended (paired with `:`)**. `:` paired with any other effect is defined to do nothing beyond what that effect already does with its own argument; a future item may give another command an extended meaning the same way, without touching this section's mechanism.

**What an interrupt row ignores.** An interrupt marker with no `:` on its row fires with argument `0`, and `: $0000` is the same thing said explicitly — there is no recall and no memory here, so a marker never inherits the previous one's argument. Everything else on the marker's row — the instrument byte, the volume and panning columns, and any effect that is not the `:` being read — is not the interrupt's business: the marker ignores all of it, and each of those columns still does exactly what it would do on any other row.

The one effect that does reach it is `S $Dx`, the note delay, which defers the marker to the tick it names exactly as it defers a key-off or a note cut. Since the engine reads that delay from the **first** effect slot only, a row wanting both a delay and an argument spells them `S $Dxny` then `: $xxxx`, in that order — which needs the wide cell, there being only one effect slot in a version-1 or version-2 song to put the `S` in. A delayed marker in those formats therefore always says `0`.

**Compatibility.** Unique to Taud — no ST3/IT/PT/FT2 source ever emits it, and no converter needs to handle it. Its EXTENSION reading is unique to Format 3 as well, a version-2 song having no second effect slot to put it in; its interrupt-argument reading works in every version, the marker it serves living in the note column rather than beside it.

**Implementation.** `applyTrackerRow` (`src/engine/row.js`) resolves the pairing once per row, before either effect slot dispatches: if exactly one slot holds `:`, the OTHER slot's dispatch call receives the `:`'s argument as an extra, optional parameter (`ext`); if neither or both slots hold `:`, both dispatch calls receive nothing extra. `:` reaching `applyEffectRow` (`src/engine/effects.js`) in its own slot — unpaired, or paired with another `:` — hits a bare no-op case, which is what makes Format 1/2 inert for free: those formats have no second slot, so `:` can never be anything BUT unpaired there.

The interrupt reading is resolved earlier and independently, in the same function's note handling (`interruptArgOf`): an `Int` marker takes the first slot's argument if that slot holds a `:`, else the second slot's if that one does, else `0`. It only reads, so the pairing resolution above runs afterwards unchanged and one `:` can serve both readers on the same row.

## 8 $xyzz — Bitcrusher

**Plain.** Applies a bitcrusher to the current voice. The crusher has two independent stages — a sample-rate reducer (`zz`, sample-and-hold) and a bit-depth quantiser (`y`) — and shares its clipping mode (`x`) with effect 9 (Overdrive). The two stages are orthogonal: enabling either is sufficient to engage the effect, and either can be active alone.

- **x — clipping mode** (shared with effect 9): `0` clamp (hard limit at ±1.0), `1` fold (ping-pong around ±1.0; values outside the range mirror back symmetrically), `2` wrap (saw-tooth wrap mod 2; ±1 are fixed points so no DC step at the boundary). Values 3..F are reserved and treated as clamp.
- **y — bit depth**, range $1..$F. `0` disables the quantiser stage. `1` reduces the voice to a 1-bit (sign-only) signal. `8..F` are accepted but produce no audible quantisation, since TSVM's mix bus is already 8-bit; they are reserved for future hardware revisions.
- **zz — sample skip**, range $00..$FF. `0` disables skip; non-zero N holds the post-quantiser output for N additional output samples (i.e. emit one fresh sample every N+1). The held value is the bitcrusher's *output*, so the sample-and-hold is downstream of the quantiser and the shared clipper.
- `8 $0000` disables both stages and resets the shared clipping mode to clamp.
- `8 $x000` updates only the shared clipping mode and leaves the active depth/skip undisturbed — useful for switching between clamp/fold/wrap mid-pattern without retyping the whole argument. The same form on effect 9 has identical semantics.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent. The effect has no memory: every cell that names effect 8 **MUST** spell out its full argument (apart from the `$x000` shorthand described above). `8 $1100` ⇒ 1-bit, no skip, fold-clipped — a useful sanity check pattern.

**Implementation.** Per-voice state: `bitcrusherDepth` (0..15; 0 = quantiser off), `bitcrusherSkip` (0..255), `bitcrusherCounter` (mod skip+1), `bitcrusherHeld` (last emitted sample), and `clipMode` (0..2, shared with effect 9). On row parse:

```
on row parse (8 $xyzz):
    voice.clipMode = x & 3
    if arg == $0000:
        voice.bitcrusherDepth = 0
        voice.bitcrusherSkip = 0
        voice.bitcrusherCounter = 0
    else if y == 0 and zz == 0:
        # x000 — clip-mode-only update; preserve depth/skip/counter
        pass
    else:
        voice.bitcrusherDepth = y
        voice.bitcrusherSkip   = zz
        voice.bitcrusherCounter = 0
```

On every output sample, after `applyVoiceFilter` and *after* the overdrive stage of effect 9:

```
on output sample (per voice):
    if voice.bitcrusherCounter == 0:
        s' = sample          # post-overdrive input
        if 1 ≤ voice.bitcrusherDepth ≤ 7:
            s' = clip(s', voice.clipMode)         # ensure in-range before quantising
            levels = (1 << voice.bitcrusherDepth) - 1
            q = round((s' + 1) × 0.5 × levels)    # nearest integer; clamp to [0, levels]
            s' = (q / levels) × 2 - 1
        voice.bitcrusherHeld = s'
        out = s'
    else:
        out = voice.bitcrusherHeld
    if voice.bitcrusherSkip > 0:
        voice.bitcrusherCounter = (voice.bitcrusherCounter + 1) mod (voice.bitcrusherSkip + 1)
```

The clipper is shared between effects 8 and 9 and is implemented as a single helper:

```
clip(x, mode):
    if mode == 1:                        # fold (triangle)
        while x > +1: x = 2 - x
        while x < -1: x = -2 - x
        return x
    if mode == 2:                        # wrap (saw, period 2)
        v = ((x + 1) mod 2 + 2) mod 2
        return v - 1
    return clamp(x, -1, +1)              # mode 0 (and reserved values)
```

The voice-FX state is preserved verbatim by the NNA-ghost copier, so the post-NNA tail of a note keeps the same timbre as the foreground voice that spawned it.

**Metainstruments.** The crusher is the CHANNEL's colouring, not one voice's, so it **MUST** reach every voice the channel is sounding: the foreground layer plus every layer-child voice on it. A crusher already in force when a metainstrument is struck **MUST** likewise be inherited by the layer children the trigger spawns — otherwise only the first layer of a kit is ever crushed, and the rest of it plays through clean.

**Persistence.** Being the channel's colouring is also what scopes its lifetime: the settings survive a note, a note-off and an instrument change, and nothing but another effect-8 cell changes them. A **transport reset** is the exception — a full reset and a play-from-row reset alike **MUST** clear `bitcrusherDepth`, `bitcrusherSkip`, the hold state and the shared `clipMode`, exactly as they return the channel's panning and volume (Engine Spec §15); otherwise a song that crushed once is still crushed on the replay, for every row up to its next effect-8 cell. Effect 9's `overdriveAmp` follows the same rule.

## 9 $x0zz — Overdrive

**Plain.** Amplifies the voice's post-filter signal and routes it through the shared clipper. With `x = 0` (clamp) the effect is a hard-knee soft-clipping distortion; with `x = 1` (fold) it becomes a wave-folder; with `x = 2` (wrap) it produces aggressive aliased fuzz with sawtooth-style discontinuities at the rails. Volume **MUST NOT** be re-normalised after clipping — `9 $00FF` clamp-clipped plays at roughly the same loudness as the dry voice once everything saturates. The middle nibble is reserved and **MUST** be zero.

- **x — clipping mode** (shared with effect 8): `0` clamp, `1` fold, `2` wrap (see effect 8 for the precise transfer functions). Values 3..F are reserved and treated as clamp.
- **zz — amplification index**, range $00..$FF. The applied gain is `(16 + zz) / 16`, so `$00` is 1.0× (effect inactive), `$10` is 2.0× (+6 dBFS), `$F0` is 16.0× (+24 dBFS), and `$FF` is 16.9375× (≈ +24.55 dBFS).
- `9 $0000` resets the overdrive (gain returns to unity, the stage stops processing) **and** resets the shared clipping mode to clamp.
- `9 $x000` updates only the shared clipping mode and leaves the active amplification undisturbed — symmetric with `8 $x000`.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent. The effect has no memory.

**Implementation.** Per-voice state: `overdriveAmp` (0..255; 0 = effect off) and `clipMode` (shared with effect 8). On row parse:

```
on row parse (9 $x0zz):
    voice.clipMode = x & 3
    if arg == $0000:
        voice.overdriveAmp = 0
    else if zz == 0:
        # x000 — clip-mode-only update; preserve amp
        pass
    else:
        voice.overdriveAmp = zz
```

On every output sample, after `applyVoiceFilter` and *before* the bitcrusher stage of effect 8:

```
on output sample (per voice):
    if voice.overdriveAmp > 0:
        sample = sample × (16 + voice.overdriveAmp) / 16
        sample = clip(sample, voice.clipMode)
```

When both effects 8 and 9 are active on the same voice the chain is **filter → overdrive (×gain → clip) → bitcrusher (bit-depth quantise → sample-skip hold)**. Because the clipper is shared, changing `clipMode` from either effect propagates to the other on the next sample — there is one mode per voice, not one per stage.

**Metainstruments.** As with effect 8: the amplification and the clip mode **MUST** be written to every voice the channel is sounding, and a layer child spawned while an overdrive is in force **MUST** start out driven.

# The S subcommand family

S is a multiplexing opcode; the **high nibble of the high byte** selects the sub-effect, and the remainder is the sub-argument.

## S $0x00 — Amiga LPF/LED Switch

**Plain.** `$0100` turns filter off; `$0000` turns it on. The parameter of the filter is dependent on the current interpolation mode: follows Amiga 1200 LPF on 1200 mode, Amiga 500 LPF on 500 mode. For other interpolation modes, this command is no-op. (see § Effects that modifies global behaviour)

**Compatibility.** ST3/IT `S00`/`S01` and PT `E00`/`E01` map directly. To actually hear the effect, the interpolation mode **MUST** be set to one of the two Amiga modes.

**Implementation.** Per-playhead boolean `ledFilterOn` (default off). Writes from row are gated on `interpolationMode ∈ {Amiga 500, Amiga 1200}`; in linear / no-interp / default modes the filter chain is bypassed entirely so the toggle is a silent no-op. The post-mix LPF chain runs on the stereo bus (left/right state per playhead) before dithering: in Amiga 500 mode a 1-pole RC LPF (R = 360 Ω, C = 0.1 µF, fc ≈ 4421 Hz) is always applied; in Amiga 1200 mode that LPF is bypassed (cutoff ~34 kHz, above Nyquist at any rate the engine runs at — matches `pt2_paula.c`). When the LED toggle is on, an additional 2-pole Sallen-Key LPF (R1=R2=10 kΩ, C1=6800 pF, C2=3900 pF, fc ≈ 3091 Hz, Q ≈ 0.660) is run after the mode LPF. Coefficients precomputed once at the running SAMPLING_RATE (recomputed if it moves, so both corners stay at their analogue frequencies); recurrence follows musicdsp.org #38 with `pt2_rcfilters.c` parameter mapping.

## S $1x00 — PT/ST3/IT Glissando control

**Plain.** `$1000` turns glissando off; `$1100` turns it on. When on, tone portamento (G) output **MUST** be quantised to the nearest semitone ($0155 approximation) before being sent to the mixer. The internal G pitch counter **MUST** still advance smoothly; only the audible pitch steps. **This command is implemented solely for ST3/IT compatibility** and therefore only works in 12-TET context.

**Compatibility.** ST3/IT `S10`/`S11` and PT `E30`/`E31` maps directly. In Taud, "nearest semitone" uses the best integer approximation: round `pitch / $155` to the nearest integer, multiply by $155; equivalently, `snapped = (pitch + $AB) / $155 × $155`. Because $155 is an approximation of 4096/12, accumulated rounding across many octaves will drift by up to a few cents; this is documented behaviour and intentional given the microtonal grid.

**Implementation.** Maintain a per-channel boolean `glissando_on`. When G updates `pitch`, if `glissando_on` is set, compute `display_pitch = round(pitch × 12 / 4096) × 4096 / 12` (using integer division with rounding) and send `display_pitch` to the mixer; otherwise send `pitch` directly.

## S $2x00 — Set fine-tune

**Plain.** Overrides the current note's fine-tune by applying a fixed 4096-TET offset. The index `$x` selects one of sixteen predefined pitch offsets, following ScreamTracker 3's Hz-based fine-tune table but expressed directly in Taud units. This command is implemented for ST3 compatibility.

**Compatibility.** The index scheme matches ST3 exactly: `$8` is the baseline (no change), `$0..$7` are progressively flatter, `$9..$F` are progressively sharper. The Hz reference values come from the ST3 User's Manual and are reproduced here for auditability; the Taud offset is `log2(Hz / 8363) × 4096`, rounded to the nearest integer. **Format converters SHOULD apply the offset to the note value directly.**

| $x | Reference Hz | Taud offset |
|---|---|---|
| $0 | 7895 | −$0154 |
| $1 | 7941 | −$0132 |
| $2 | 7985 | −$0111 |
| $3 | 8046 | −$00E4 |
| $4 | 8107 | −$00B8 |
| $5 | 8169 | −$008B |
| $6 | 8232 | −$005D |
| $7 | 8280 | −$003B |
| $8 | 8363 | $0000 |
| $9 | 8413 | +$0023 |
| $A | 8463 | +$0046 |
| $B | 8529 | +$0074 |
| $C | 8581 | +$0098 |
| $D | 8651 | +$00C8 |
| $E | 8723 | +$00F9 |
| $F | 8757 | +$0110 |

ProTracker `E5x` maps to Taud `S $2x00` with the same index meaning.

**Implementation.** On the row, look up the offset from the table and add it to the channel's base pitch before any other per-tick effect processes. The offset persists until another S $2x command or a note-reset event.

## S $3x00 — Vibrato LFO waveform

**Plain.** Selects the shape of the vibrato (H and U) oscillator.

| $x | Waveform | Retrigger on new note? |
|---|---|---|
| $0 | Sine | Yes |
| $1 | Ramp down (sawtooth) | Yes |
| $2 | Square | Yes |
| $3 | Random | Yes |
| $4 | Sine | No |
| $5 | Ramp down | No |
| $6 | Square | No |
| $7 | Random | No |

**Compatibility.** ST3 `S3x` and ProTracker `E4x` maps directly.

**Implementation.** Store `vibrato_waveform = $x & $3` and `vibrato_retrigger = (($x & $4) == 0)` for the channel. The ramp-down shape is `$7F − ((pos & $3F) << 2)` across one logical cycle; the square shape is `sign(sine(pos)) × $7F`; random draws a fresh `rand() & $FF − $80` every tick. On a new note, if `vibrato_retrigger` is true, reset `lfo_pos = 0`.

## S $4x00 — Tremolo LFO waveform

**Plain.** Selects the shape of the tremolo (R) oscillator; value encoding is identical to S $3x.

**Compatibility.** ST3 `S4x` and ProTracker `E7x` maps directly.

**Implementation.** As for S $3x, but applied to R's separate state (`tremolo_waveform`, `tremolo_retrigger`, and tremolo `lfo_pos`).

## S $5x00 — Panbrello LFO waveform

**Plain.** Selects the shape of the panbrello (Y) oscillator; value encoding is identical to S $3x.

**Compatibility.** IT `S5x` maps directly.

**Implementation.** As for S $3x, but applied to Y's separate state (`panbrello_waveform`, `panbrello_retrigger`, panbrello `lfo_pos` and `panbrello_offset`).

## S $6x00 — Fine pattern delay

**Plain.** Extends the current row by $x ticks. If multiple S6x commands are on the same row, the sum of their parameters is used.

**Compatibility.** IT `S6x` maps directly.

**Implementation.** Maintain a per-row accumulator `fine_delay_extra` on the tracker state, initialised to 0 at the start of every row parse (including pattern-delay repetitions caused by S $Ex). Each S $6x command encountered during the row scan adds `$x` to `fine_delay_extra`. The row then runs for `speed + fine_delay_extra` ticks instead of the usual `speed` ticks before advancing to the next row.

```
on row parse (S $6x):
    fine_delay_extra += x       # sum across all channels

row ends when:
    tick_in_row >= ticks_per_row + fine_delay_extra
```

S $6x and S $Ex are orthogonal: when S $Ex is active the current row repeats `$x` additional times, and each repetition is itself extended by `fine_delay_extra` (re-accumulated from the same row's S $6x commands). There is no memory for S $6x; `$x == 0` is a no-op.

## S $7x00 — Note/Instrument actions

**Plain.** Performs following action to the note.

| $x | Operation | Description |
|---|---|---|
| $0 | Past Note Cut | Cuts all notes playing as a result of New Note Actions on the current channel |
| $1 | Past Note Off | Sends a Note Off to all notes playing as a result of New Note Actions on the current channel |
| $2 | Past Note Fade | Fades out all notes playing as a result of New Note Actions on the current channel |
| $3 | NNA Note Cut | Sets the currently active note's New Note Action to Note Cut |
| $4 | NNA Note Continue | Sets the currently active note's New Note Action to Continue |
| $5 | NNA Note Off | Sets the currently active note's New Note Action to Note Off |
| $6 | NNA Note Fade | Sets the currently active note's New Note Action to Note Fade |
| $7 | Volume Envelope Off | Disables the currently active note's volume envelope |
| $8 | Volume Envelope On | Enables the currently active note's volume envelope |
| $9 | Panning Envelope Off | Disables the currently active note's panning envelope |
| $A | Panning Envelope On | Enables the currently active note's panning envelope |
| $B | Pitch Envelope Off | Disables the currently active note's pitch or filter envelope |
| $C | Pitch Envelope On | Enables the currently active note's pitch envelope  |
| $D | Filter Envelope Off | Disables the currently active note's filter envelope |
| $E | Filter Envelope On | Enables the currently active note's filter envelope  |

When the instrument have both pitch and filter envelopes defined, $B/$C toggles pitch envelope only.

**Compatibility.** For $x in 0..$C, IT `S7x` maps directly. $D and $E differs from MPTM and unique to Taud

**Implementation.** Engines maintain a *mixer-private* background-voice pool per playhead, separate from the addressable foreground voices. When a fresh note retriggers a still-active foreground voice, the engine reads the effective NNA — the per-voice override set by `S $73..$76` if present, otherwise the instrument's default NNA (instrument record byte 186, low two bits) — and acts on the displaced voice as follows:

- **Note Cut (1):** discard the foreground state in place; no ghost is created.
- **Note Off (0):** clone the foreground voice into the background pool and set its key-off flag, releasing any sustain loop. The clone's volume envelope plays out and fadeout decays from full.
- **Continue (2):** clone the foreground voice into the background pool unchanged; envelopes and sample position continue from where they were.
- **Note Fade (3):** clone the foreground voice into the background pool and immediately begin fadeout decay without releasing sustain. The volume envelope keeps looping its sustain region while fadeoutVolume drains to zero.

Note Fade and Note Off are distinct: Note Fade does **not** set key-off, so the volume envelope's sustain loop continues to cycle; Note Off does set key-off, breaking sustain. Both share the same fadeout slope (`volumeFadeoutLow + (fadeoutHigh & 0x0F << 8)` units per tick out of 1024).

The background pool is reaped when a ghost's `fadeoutVolume` drops to zero or its sample finishes (non-looping). Pool size is implementation-defined; the reference engine caps it at 64 ghosts per playhead and evicts the oldest on overflow. Background voices receive only passive per-tick maintenance (envelope advance, fadeout decay, auto-vibrato, filter coefficient refresh) — no row-driven effects (vibrato/tremolo/arpeggio/Q-retrigger/cut/delay) ever target them, since they are not addressable from the pattern.

`S $70..$72` (Past Note Cut/Off/Fade) operate on every ghost whose `sourceChannel` matches the issuing channel: $70 drops them outright, $71 sets key-off on each, $72 begins fadeout on each.

`S $73..$76` write the per-voice NNA override on the **currently active foreground voice** so that *its* next NNA event uses the overridden action. The override is cleared on every fresh trigger.

`S $77..$7E` toggle an envelope on the currently active voice. The engine **MUST** keep **four independent gates** — volume, panning, pitch, filter — so the four pairs act on disjoint state:

- `$77 / $78` — volume envelope off / on.
- `$79 / $7A` — panning envelope off / on.
- `$7B / $7C` — **pitch** envelope off / on, *when the instrument defines a pitch envelope*. On an instrument that defines only a filter envelope (the IT case where the single pitch/filter slot is flagged as a filter env), `$7B / $7C` fall back to toggling that filter envelope — this is the IT "pitch or filter envelope" semantics. When the instrument defines **both** envelopes, `$7B / $7C` toggle the pitch gate only and leave the filter gate untouched.
- `$7D / $7E` — **filter** envelope off / on (Taud-specific; differs from MPTM). These always target the filter gate regardless of what else is defined.

While a gate is disabled the corresponding envelope is frozen (no advancement) and the mixer treats its contribution as unity (volume / pan / pitch / filter value replaced by the neutral 1.0 / 0.5 / 0.5 / 0.5).

Because the engine resolves the byte-19 and byte-197 envelope slots into explicit pitch and filter roles at trigger time (by reading each slot's `m`-bit — the slot order is undefined: on some songs offset 19 is the pitch env, on others it is the filter env), the `$7B`/`$7C` vs `$7D`/`$7E` dispatch reads those resolved roles directly and does not re-inspect the `m`-bits per event.

Effect $7..$E applies to ordinary instruments. When used on a metainstrument, the effect **MUST** be applied onto the constituent instruments all at once — the reference engine fans the toggle out across the foreground layer plus every layer-child voice sounding on the channel. Effect $0..$6 is a **no-op** on metainstruments: a live meta's layer-child voices are themselves background ghosts, so a Past-Note action ($70..$72) would otherwise cull the very layers that make up the sounding note.

## S $80xx — Set channel pan position

**Plain.** Sets `channel_pan` (§3a) to `$xx`, with $00 being full left and $FF being full right. $80 is centre. It writes the CHANNEL axis, so it places the part and leaves each note's own offset — an Ixmp zone pan, a panning-column SET — standing on top of it: over a zone-panned instrument this command rotates the whole arrangement rather than collapsing it. A panning-column SET on the same row is not a conflict and both **MUST** apply; the two address different registers.

In surround mode, the lower 9 bits encodes angle, $000 being left (0°), $080 being front (90°), $100 being right (180°), $180 being behind (270°), $1FF being almost left (~360°). The angle therefore runs CLOCKWISE seen from above, and its low 8 bits are exactly the stereo pan byte — `S $80xx` keeps its old meaning and lands on the front semicircle.

**Compatibility.** IT `Xxx` maps directly. ST3 `S8x` uses a 4-bit value. Convert by nibble-repeat: ST3 `S83` → Taud `S $8033`. ProTracker `8xx` (fine pan) and `E8x` (coarse pan) both map into Taud's 8-bit pan — the ProTracker 8-bit form maps directly; the 4-bit form nibble-repeats. All four source commands write one channel pan register, and this is the command that means what they meant, so a converter **SHOULD** emit them here rather than in the panning column: the column's SET is the per-NOTE axis (§3a) and only coincides with them while the channel stays centred.

**Implementation.** Write `channel_pan = arg & $FF`. The mixer sums it with `note_pan` and the pan envelope (§3a) and applies the equal-energy law to the total: `left_gain = cos(π × position ÷ 512)`, `right_gain = sin(π × position ÷ 512)`, both before the global volume stage.

## S $Bx00 — Pattern loop

**Plain.** Sets a loop point and loops within a pattern. `S $B000` marks the current row as the loop start (per channel, not per song); `S $Bx00` with $x > 0 returns playback to the saved row and plays the intervening range `$x` more times (so `$B200` plays the loop twice total beyond the initial pass).

**Compatibility.** ST3 `SBx` maps directly. ProTracker `E6x` maps to Taud `S $Bx00`.

ST3 has a long-documented bug where pattern delay (SEx) inside a pattern-loop range causes the loop counter to decrement multiple times per visit, producing unintended behaviour. **Taud fixes this bug.** On import, ST3 songs that relied on the bug will loop fewer times in Taud. Converters that want bit-exact ST3 playback **SHOULD** emit a warning when SBx and SEx appear in the same channel within a loop range, and **MAY** flatten loops by duplicating rows.

**Implementation.** State per channel: `loop_start_row` (defaulting to 0 at each pattern entry) and `loop_count` (defaulting to 0).

```
on row event (S $Bx00):
    x = (arg >> 8) & $0F
    if x == 0:
        loop_start_row = current_row
    else:
        if loop_count == 0:
            loop_count = x
            jump next_row -> loop_start_row
        else:
            loop_count -= 1
            if loop_count > 0:
                jump next_row -> loop_start_row
            # else loop_count hits 0 on its own; fall through to next row

on pattern change: loop_start_row = 0; loop_count = 0
```

The crucial bug fix relative to ST3: the loop-counter decrement **MUST** happen **once per actual row playback**, not once per tick-0 invocation. When SBx shares a row with SEx (pattern delay), the pattern-delay machinery replays the row as a unit, but the SBx state machine **MUST** treat the whole delay group as a single visit. Engines **SHOULD** implement this by gating the SBx decrement on `pattern_delay_repetition == 0`.

## S $Cx00 — Note cut in $x ticks

**Plain.** Silences the note on tick `$x` of the current row by forcing the channel's output volume to 0. The sample continues running internally, so a later volume-change or retrigger event can resume audio.

**Compatibility.** ST3 `SCx` maps directly. ProTracker `ECx` also maps directly. ST3 ignores `SC0` (treats it as no cut at all); Taud preserves this.

**Implementation.** On tick `$x`, the engine **MUST** set `output_volume = 0` but **MUST** leave `base_volume` unchanged. If `$x ≥ speed`, the cut **MUST NOT** fire. If `$x == 0`, the command **MUST** be ignored. The engine **MUST** set the `note_was_cut` flag so that a later Q retrigger on the same row is suppressed.

## S $Dxny — Note delay for $x ticks, then note action $n after $y ticks

**Plain.** Delays the triggering of the note (and any co-row instrument, offset, and volume event) until tick `$x`. Until then, any currently playing note continues. If `$y` is nonzero, following action will be triggered after `$y` ticks after note triggering.

|`$n`|Action|
|---|---|
|0|Note off|
|1|Note cut|
|2|Note continue|
|3|Note fade|
|4|Key lift|

Expressed in timeline, this effect does (assuming nonzero `$x` and `$y`):

|Ticks|Action|
|---|---|
|0|Nothing|
|`$x`|Note triggers|
|`$x`+`$y`|Note action specified as `$n`|

If `$y` is zero:

|Ticks|Action|
|---|---|
|0|Nothing|
|`$x`|Note triggers|

If `$x` is zero:

|Ticks|Action|
|---|---|
|0|Note triggers|
|`$y`|Note action specified as `$n`|

If both are zero:

|Ticks|Action|
|---|---|
|0|Note triggers|

**Compatibility.** ST3 `SDx` maps directly. ProTracker `EDx` also maps directly. FastTracker `Kxx` maps to `S D00xx`. OpenMPT `:xy` maps to `S Dx1y`. `S D0**` plays the note normally on tick 0. If `$x ≥ speed`, the note **MUST NOT** play on this row and **MUST NOT** carry over to the next row. Some trackers allow playback of "malformed" note delays (`$x` greater than current tick speed); Taud **MUST** discard those notes. If such note events have been encountered during conversion, they **MUST** be corrected by the converter. The `$x` delay applies to every note-column event, the sentinels and the interrupt markers included — see the [`:` section](#-xxxx--interrupt-argument-and-argument-extension) for what a delayed `Int` means.

**Implementation.** On row parse, the engine **MUST** defer the note-trigger event (including sample selection, volume, offset, and any volume-column effect) until tick `$x`. On tick `$x`, the engine **MUST** execute the deferred trigger. When combined with pattern delay (S $Ex00), the deferred trigger **MUST** re-fire at the start of each row repetition — matching ST3's `kRowDelayWithNoteDelay` behaviour. If `$x` is greater than the current tick speed, the note **MUST** be discarded (see compatibility notes above). If `$x + $y` is greater than the current tick speed, the action `$n` will be discarded.

## S $Ex00 — Pattern delay for $x row-repeats

**Plain.** Repeats the current row `$x` additional times (so `$x = 0` means no repeat and the row plays once; `$x = 3` means the row plays four times total). Notes do not retrigger across repetitions, but per-tick effects re-run and tick-0 events (fine slides, delayed notes) re-fire on each repetition.

**Compatibility.** ST3 `SEx` maps directly. ProTracker `EEx` also maps directly. Simultaneous SEx on multiple channels: ST3 uses the first SEx in **pan order** (L1..L8 then R1..R8); **Taud uses the first SEx in ascending channel-index order** for predictability. Converters that encounter ST3 songs relying on the pan-order rule **SHOULD** emit a warning.

Q retrigger counters do **not** reset between SEx repetitions.

**Implementation.** Row duration becomes `speed × (1 + arg_x)` ticks. Treat each repetition as a fresh row for tick-0 purposes (so fine slides, delayed notes, and the like re-trigger), but do not reset arpeggio, vibrato, or tremolo LFO positions, and do not decrement SBx's loop counter more than once across the whole delay block.

## S $F0xx — Invert loop with speed $xx (non-destructive)

**Plain.** Produces a hiss-like progressive inversion of the sample loop, toggling individual bytes over time for a gritty textural effect. Setting `$x = 0` turns the effect off; higher `$x` advances the inversion faster.

**Which ProTracker effect this is.** `E $Fx` is one slot that held two entirely different algorithms. ProTracker **1.0C** used it for **Funk Repeat**, which moves the playback loop a whole loop length at a time and leaves the sample alone; **1.1B** threw that step away and put **Invert Loop** in its place, one's-complementing the loop's bytes where they lie. Everything since implements the replacement. PT's own sources never renamed the routine around it — `mt_FunkIt`, `n_funkoffset` and `mt_FunkTable` are Invert Loop's code in every version anyone reads — which is how the two came to be treated as one effect described two ways. They are not. **This command is Invert Loop**; Funk Repeat is `Z $Ffxx`, they are independent, and they **MAY** run on one voice at once. Only the speed ladder is genuinely shared, and it keeps its historical name (`funk_table`) here because that is the name it carries in every source that has it.

**Compatibility.** ProTracker `EFx` is destructive — it XORs bytes directly in the sample data, permanently corrupting the sample. **Taud's implementation MUST be non-destructive**: the XOR **MUST** be applied at playback time through a per-instrument bit-mask, leaving source samples pristine. ST3 does not implement SFx at all and will parse Taud's S $Fx00 as a no-op; converters targeting ST3 **SHOULD** drop the effect. ProTracker `EFx` imports as Taud `S $F0yy`, where `yy = funk_table[x]`.

**Implementation.** Each instrument carries an `invert_mask` bit array, one bit per byte of the loop region, all zero at song start. A per-channel counter `invert_accumulator` and a per-channel `invert_write_pos` track progress.

```
funk_table[16] = { 0, 5, 6, 7, 8, $A, $B, $D, $10, $13, $16, $1A, $20, $2B, $40, $80 }

on every tick (when S $F0xx is active with xx != 0):
    invert_accumulator += invert_speed                # $xx, a funk_table value
    if invert_accumulator >= $80:                     # hard reset, drops residual
        invert_accumulator = 0
        invert_write_pos = (invert_write_pos + 1) mod loop_length    # pre-increment
        invert_mask[invert_write_pos] = invert_mask[invert_write_pos] XOR 1

on sample byte read during loop playback:
    raw_byte = sample_data[offset_in_loop]
    if invert_mask[offset_in_loop] == 1:
        output_byte = raw_byte XOR $FF
    else:
        output_byte = raw_byte
```

Effects `2` and `3` offer the same inversion over a region you choose as one of several operations — see their entry. They keep their own mask; this one is `S $F0xx`'s alone.

Inversion is an involution, so a byte hit twice is back as it was: one traversal of the loop inverts every byte, a second restores every one, and the cycle is `2 × loop_length` steps. What the ear follows over that cycle is a sweep from clean, through progressively more inverted, to fully inverted — which is *also* clean, reflected — and back. On the signed samples ProTracker used, `$FF − s` is `−s − 1`: a reflection about −0.5 rather than a negation, which is where the buzz comes from.

The middle nibble of the argument is **reserved**: the command is spelled `S $F0xx` and an engine **MUST NOT** read anything from `$x`, so every spelling behaves as `$0` does. `S $F000` **MUST** clear `invert_accumulator` but **MUST** leave `invert_mask` intact (the accumulated inversion pattern persists). This is a deliberate difference from `Z $Ffxx`, whose accumulator runs free the way ProTracker's did: `S $F0xx` has cleared it since it shipped, songs are written against that, and re-phasing an inversion the listener is already hearing is not worth the fidelity. **On every fresh note trigger**, `invert_write_pos` **MUST** reset to 0 (matching PT2's `n_wavestart = n_loopstart`); `invert_accumulator` and `invert_speed` **MUST** persist across notes. The `invert_mask` itself **MUST** be cleared only on cue-start reset (i.e. song-start / stop-and-replay) — within a single playback session it accumulates as PT2's destructive in-place edits would, but a clean replay **MUST** reproduce the same audio without needing to reload the song from disk.

The mask is indexed against the loop the instrument **declares**, and `Z $Ffxx` running on the same voice does not move it: the walked window is where the voice is reading, the mask is what the bytes there read as, and each keeps its own frame.

The ladder both commands read is ProTracker's own `mt_FunkTable`, byte-identical in 1.0C and 1.1B. Because the accumulator is **reset to zero** on overflow rather than reduced by `$80`, the remainder is discarded and the period is exactly `ceil($80 ÷ table_value)` ticks with no jitter — the table was chosen to make that a clean ladder. A tick here is an engine tick, so the step rate does **not** scale with the song's speed: a slower song simply spends more ticks per row and steps more often within it.

| PT `E $Fx` | Taud `$xx` | Steps every … ticks |
| ---: | ---: | ---: |
| `$0` | `$00` | *(off)* |
| `$1` | `$05` | 26 |
| `$2` | `$06` | 22 |
| `$3` | `$07` | 19 |
| `$4` | `$08` | 16 |
| `$5` | `$0A` | 13 |
| `$6` | `$0B` | 12 |
| `$7` | `$0D` | 10 |
| `$8` | `$10` | 8 |
| `$9` | `$13` | 7 |
| `$A` | `$16` | 6 |
| `$B` | `$1A` | 5 |
| `$C` | `$20` | 4 |
| `$D` | `$2B` | 3 |
| `$E` | `$40` | 2 |
| `$F` | `$80` | 1 |

Taud takes the **table value** as its argument rather than ProTracker's nibble, which is what makes the whole ladder — and everything between its rungs — writable; the `PT $x` column is the conversion. A value of `$00` is off, so an engine **MUST** test for it before doing anything else with the argument.

## Z $Ffxx — Funk repeat: hop $f at speed $xx (non-destructive)

**Plain.** Hops the sounding **loop** through the sample. The loop keeps its length, so the note goes on repeating a window of the same size at the same pitch — but every step the window jumps to another part of the sample, and when it runs out of room it comes back. Point it at a short loop inside a long sample and a held note scans the whole waveform in grains, cycling forever; the material changes, the pitch does not. `$xx` is the speed, `$00` switches it off and leaves the loop wherever the hop had taken it, and the next note on the channel puts it back.

`$f` chooses the hop, and it is the whole difference between a coarse ProTracker stutter and a granular scan: the **grain** is the loop, and `$f` says how far the grain moves and in what direction.

|  | whole loop length | half | quarter | eighth |
|---|---|---|---|---|
| **forward**, wrapping home at the top | `$0` | `$1` | `$2` | `$3` |
| **backward**, wrapping to the top at the bottom | `$4` | `$5` | `$6` | `$7` |
| **forward, jittered** — each grain thrown within ±1/16 of the walk | `$8` | `$9` | `$A` | `$B` |
| **throw** — a random position anywhere in the walk | `$C` | `$D` | `$E` | `$F` |

`Z $F0xx` is ProTracker 1.0C's own walk, so every song ever written against it means what it always meant.

**Hop size is overlap.** The hop is the loop length shifted right by `$f`'s low two bits, so `$0` moves a whole block and lays the grains end to end the way 1.0C did, while `$3` moves an eighth and reads each stretch of the sample eight times over before leaving it. Finer hops turn the coarse stutter into a slur: the same grain, crossing the material more slowly and overlapping itself more. The **window never changes size** — a shorter one would raise the pitch of what is sounding, and this command's whole point is that the pitch does not move.

**Backward is the walk, not the sample.** `$4`–`$7` run the same grid the other way: the grain still plays forwards, the scan works up the sample toward its start. Where the forward walk snaps home when the next window would not fit, the backward one wraps to the **top** — the last position that does fit — so the effect is a rising sweep rather than a falling one, and a pointer that has never moved goes there on its first step.

**Jitter and throw are the same draw at two reaches.** `$8`–`$B` are the forward walk with the landing **jittered**: the walk steps a hop as it always did, and the grain is thrown uniformly within ±1/16 of the territory **around where the walk now is**. The scan still crosses the sample in order, at the rate the speed sets; what changes is that each grain arrives a little early or a little late, so the material stays recognisable and the seams stop being regular. `$C`–`$F` ignore the walk and throw uniformly over the **whole** territory, so consecutive grains have nothing to do with each other. Both keep the hop grid, so a grain always lands where a whole hop lands rather than mid-transient — set the loop to a beat of a drum loop and `$C` re-deals it, `$8` plays it loose.

**The throw is measured from the walk, never from the last throw.** This is the rule the sample modifications' jumps and scatters follow, and it is here for the same reason: an engine that feeds each throw into the next one has built a random walk, whose spread grows without bound until the narrowest rung of the ladder is indistinguishable from the widest — the whole ladder collapses into one effect with a rise time. A conforming engine **MUST** therefore keep the walk itself free of the randomness (`funk_walk` below) and re-measure every throw from it. `$8`–`$B` **MUST** clamp a throw that would leave the territory rather than reflecting or wrapping it, which is safe precisely because the walk moves on regardless: nothing can pile up against an end it is being carried away from.

**It needs a short loop, and the reason is arithmetic.** A step is only taken to a position where the whole window still fits before the end of the sample. A loop occupying the last `n` bytes of its sample therefore has nowhere to go: every candidate overshoots, and the effect is silent — not broken, just out of room, whatever `$f` says. ProTracker's manual said this as "*This command will need a short loop ($10,20,40,80 etc. bytes) to work*", and the arithmetic is why.

**Which ProTracker effect this is.** ProTracker **1.0C**'s `E $Fx`, the original **Funk Repeat**, extended. Its `mt_UpdateFunk` added `2 × n_replen` — one loop length in bytes — to the channel's repeat pointer and wrote the result straight into Paula's `AUDxLC`; the sample data was never touched. 1.1A shipped the same help file and the same effect list (`EF- FunkRepeat … (add replen to repeat)`), and **1.1B replaced the step body** with the byte inverter that is `S $F0xx` here, keeping the handler, the ladder, the accumulator and every `funk` name — it did not even drop `n_reallength`, the field only Funk Repeat read, which is the clearest sign that one routine was swapped rather than a design revised. Invert Loop is therefore not a later reading of this effect; it is a different effect that inherited its slot.

**Compatibility.** A ProTracker module cannot say which of the two its `E $Fx` meant: there is no version field and no flag, and the byte is identical. The scene settled on Invert Loop — everything from PT 2.x onward implements only that — so converters **SHOULD** keep emitting `S $F0yy` (`yy = funk_table[x]`) for `E $Fx` and offer `Z $F0yy` as a deliberate choice for modules known to predate 1.1B. An engine **MUST NOT** guess between them. A converter **MUST NOT** emit any other `$f`: the other fifteen walks have no ProTracker meaning and cannot be what a `.mod` intended. ST3, IT and FT2 implement none of it; FT2's own help lists `E $Fx` as "Funk it! (Not implemented)". Unique to Taud otherwise, and it has no memory slot: `Z $F000` is *off*, not a recall, and it does not disturb the memory `Z $0xxx` keeps.

**Implementation.** Per-channel state: `funk_speed`, `funk_mode` (`$f`), an 8-bit `funk_accumulator`, the deterministic `funk_walk`, the pointer `funk_pointer` that the next restart will take (ProTracker's `n_wavestart`, and the same number as `funk_walk` for `$0`–`$7`) and the `funk_window` the voice is actually sounding, plus whatever the seam crossfade below needs (the reference engine keeps a countdown and the byte offset back to the window the hop replaced). The clock is `S $F0xx`'s, unchanged — same `funk_table`, same overflow test, same hard reset — so the ladder table in that entry serves both commands.

```
hop        = max(1, loop_length >> (funk_mode AND 3))
K          = floor((sample_length - loop_length - loop_start) / hop)
position k = loop_start + k * hop,  for k = 0 … K

on every tick, when funk_speed != 0 and the voice has a real forward or
ping-pong loop that fits inside its sample:
    funk_accumulator = (funk_accumulator + funk_speed) AND $FF
    if funk_accumulator AND $80:                      # bit 7 set = step
        funk_accumulator = 0                          # reset, NOT -= $80
        if K <= 0:                                    # no room: inert
            funk_walk = funk_pointer = loop_start
        else:
            # 1. the WALK steps, and nothing random ever touches it
            k = clamp(round((funk_walk - loop_start) / hop), 0, K)
            if (funk_mode >> 2) == 1:  k = (k - 1 < 0) ? K : k - 1   # backward
            else:                      k = (k + 1 > K) ? 0 : k + 1   # forward
            funk_walk = loop_start + k * hop

            # 2. the GRAIN is placed against it, re-measured from the walk
            #    EVERY step — never from where the last throw landed
            case funk_mode >> 2 of
              0, 1:  funk_pointer = funk_walk                        # as it lies
              2:     reach = max(1, round((K + 1) / 16))             # jittered
                     j = clamp(k + uniform(-reach … +reach), 0, K)
                     funk_pointer = loop_start + j * hop
              3:     funk_pointer = loop_start + uniform(0 … K) * hop  # thrown

the sounding loop is:
    [funk_window, funk_window + loop_length)          once the walk has moved
    [loop_start, loop_end)                            until then

when playback reaches the end of the sounding loop:
    funk_window = funk_pointer                        # the restart latches it
    position = funk_window + overshoot
```

With `$f = $0` the hop is one loop length, `K` is the number of whole blocks past the first, and the whole thing collapses to ProTracker's own step: the walk visits `loop_start + k × loop_length` for `k = 0 … K` and returns to `k = 0`, a cycle of `K + 1` positions.

**The pointer lives on the grid.** Every walk moves between grid positions, never between arbitrary bytes, which is what keeps a hop landing where a hop lands. `$f` may be rewritten under a running walk, so the walk **MUST** be re-quantised onto the new grid before the step (the `round` above) rather than stepped from where it happens to lie: a finer grid contains every coarser one, so going finer never moves the window, and going coarser moves it to the nearest whole hop instead of leaving it stranded between two.

**Both random families MUST draw uniformly, and once per step.** A draw per output sample is not a jittered walk at all but noise — one output sample is read through every interpolation tap and through both channels of a stereo sample, so a fresh draw per read smears every setting into the same hiss — and a non-uniform draw spends the reach it was given on the middle of its range.

**The accumulator is a running phase, not a period counter.** ProTracker wrote `n_funkoffset` in exactly three places, all inside the step block: the add, the test and the clear. Nothing else ever touched it — not a note, not an instrument change, not a speed change, not `E $F0`. An engine **MUST** follow that: `Z $Ffxx` **MUST NOT** reset `funk_accumulator`, so the first step after a speed change lands at whatever interval the running phase leaves rather than a clean one. Implementing the ladder as "every N ticks" instead of as this accumulator gets the steady state right and this transient wrong.

**The window changes only when the loop restarts.** Paula reloaded its internal pointer from `AUDxLC` at the loop wrap, so a step taken mid-block did nothing until that block finished, and the walk was heard as the loop moving *between* repeats. An engine **MUST** keep that: the pointer advances on the tick, the window it names takes effect at the next restart. Moving the window between two output samples instead is a step discontinuity in the middle of a grain that was still sounding. On a ping-pong loop the latch **MUST** happen at one end only (the reference engine latches on the way up), so one down-and-back counts as the single repeat it sounds like. This is what makes the fine hops usable: at `$3` the window moves an eighth of a loop at a time and is still only ever installed at a wrap.

**The seam itself is crossfaded, not cut.** Latching at the restart puts the discontinuity somewhere defensible; it does not remove it. A loop point is continuous only because whoever set it chose it to be, and the walk lands where the arithmetic puts it — so the restart that installs a hop jumps the read into material with nothing to do with the material just playing, and between two output samples that is a **click**: one per hop, up to one per tick at `$xx = $80`. An engine **SHOULD** therefore crossfade the seam, exactly as it crossfades a sample modification's step ([§8.5 of the engine spec](TAUD_ENGINE_SPEC.md)): for a short window it reads the position through **both** the window the hop installed and the window it replaced — the same position offset by (old window − new window), which is what "the previous mapping" means here — and mixes them on a weight that falls on the **output** clock, one weight per output sample shared by both channels of a stereo sample.

The reference engine fades over 64 output samples (2 ms at the reference rate) **capped at one grain**, `loop_length ÷ playback_rate` output samples. The cap is not an optimisation: this command is written for short loops — ProTracker's manual asks for `$10`, `$20`, `$40`, `$80` bytes — and on those a fixed 2 ms spans several grains, so every restart would re-arm a fade that never finished and the walk would be heard through a permanent 50 % blend of two different places in the sample. Capped at a grain, each fade completes exactly as the restart that would replace it arrives. A restart where the window did **not** move (the walk is off, or it stepped nowhere) **MUST NOT** crossfade: an ordinary loop wrap is the one seam the musician chose, and running a fade over every wrap of every looped sample would change every song that has one.

**The walk moves the loop, never the sample.** Nothing is written to sample data, and nothing is shared: the window is the voice's own, so two channels funking one instrument do not interact — the exact opposite of `S $F0xx`, whose mask belongs to the instrument. Stop the effect and the sample is as it always was.

**Reset rules.** On every fresh note trigger the walk, the pointer and the window **MUST** return to the sample's own loop, and any seam crossfade in flight **MUST** be dropped rather than carried into the new note; `funk_speed`, `funk_mode` and `funk_accumulator` **MUST** persist across notes, so a walk armed on one row keeps working on the notes that follow it. `Z $Ff00` therefore arms a walk for the speed that follows it. All six **MUST** be cleared on cue-start reset. An NNA ghost **SHOULD** keep the window it was displaced with — its playback position is inside that window — while the walk itself stays with the channel.

**Where this deliberately parts company with ProTracker 1.0C.** Three places, all of them consequences of being a software mixer rather than a DMA channel:

- **The whole window must fit.** PT compared the candidate against `sample_end − loop_length` computed with a *word* shift, so a sample of `$8000` words or more got a wrong limit; and where a module's loop ran past its sample, Paula would read whatever followed it in Chip RAM. The test above is the same one on exact arithmetic, and a conforming engine **MUST NOT** read outside the sample.
- **A trigger resets the pointer.** PT re-seeded `n_wavestart` only when the row carried a **sample number**, so a bare note left the walk mid-sweep. Here the window is an offset into the voice's *active* sample view, which a trigger rebuilds — carrying it across would aim it into a sample it was never measured against.
- **No per-row snap-back.** PT's `mt_SetDMA` rewrote `AUDxLC` from `n_loopstart` for all four channels at the top of every row, undoing the previous row's walk, so the audible 1.0C effect was "home at the top of each row, then out to wherever the cursor has got to". That is a collision between two pieces of replayer plumbing, not the effect's design — the manual describes the free walk — so Taud does not reproduce it. A song that wants the stutter can write the walk against a pattern that re-triggers.

**Other sample effects keep their own frame.** `S $F0xx`'s mask and the regions of `2 $sexy` / `3 $sexy` are indexed against the loop the instrument **declares**, and the walked window does not move them. Run the walk and the inverter together and the note hops into fresher and fresher material while the bytes under it are ground down; that is the intended composition of the two, not an accident to be corrected.

## Spatial panning effects

Three commands are reserved specifically for spatial panning, enabled via song flags.

The song's immutable `ss` flag picks the panning model: **stereo** (0), **planar** (1, panning all the way round the listener) or **spatial** (2, the whole sphere). It decides what the pan commands MEAN, so it is a property of the song rather than of playback: a stereo song ignores X / 4 / Z entirely and keeps `S $80xx` at eight bits, and a planar song keeps every source on the horizon.

**Sound sources, not speaker feeds.** A conforming engine **MUST** treat a sounding voice in a surround model as a source at a direction, and render those sources into whatever channel layout the output needs; it **MUST NOT** define the panning in terms of one particular output format. A MULTI-CHANNEL sample (the Ixmp `s` block) is therefore not two speaker feeds but a rigid arrangement of sources aimed at the voice's direction, placed at the ITU angles for its channel count — ±30° for stereo, the BS.775 / BS.2051 angles for 4, 6 and 8 channels. The arrangement yaws and pitches WITH the source, so its width survives elevation.

**Stereo output** (playback, and the stereo downmix of any surround export) **MUST** fold the rear semicircle onto the front one — two speakers cannot render front/back — and apply the ordinary equal-energy pan law to the folded angle. On the front arc this is exactly the stereo model's own law, so a song that uses nothing but ordinary pan sounds identical whichever model it declares. Elevation collapses the image toward the centre, reaching dead centre at ±90°, which is the only rule that stays continuous at the poles.

An implementation **MAY** additionally offer a **binaural monitor** — a head model that makes elevation and front/back audible on headphones while composing — and multi-channel export targets. Those are monitoring and delivery choices, not panning rules: the fold above remains the defined stereo rendering, and nothing in the file selects any of them.

### X $eeaa — Spherical panning by azimuth $aa and elevation $ee

**Plain.** In spatial surround mode, this command positions a sound source using azimuth and elevation, where azimuth 0°..360° maps to $00..$FF. Elevation is stored as a signed 8-bit integer, where −128 represents −90° and +127 represents approximately +90°.

**Compatibility.** Unique to Taud. On IT, this command is called "Fine Set Panning" and sets the panning position of the current channel, $00 being full-left and $FF being full-right. Convert to `S $80xx`.

**Implementation.** The engine **MUST** ignore this command when the song's surround model is stereo (a converter that left an IT `Xxx` in place **MUST NOT** be rewarded with a pan change). Otherwise write the **channel axis** — the exact same register `S $80xx` addresses in a stereo song, extended to a sphere rather than a segment — not the note axis: azimuth = `$aa × 2` in the 9-bit units of `S $8xxx` (so `$00` = left, `$40` = front, `$80` = right, `$C0` = behind), elevation = the signed `$ee`. `S $8xxx` and `X` are therefore interchangeable on the azimuth they share — whichever ran last on the channel wins — and `X`'s elevation term is additional channel state alongside it. A PLANAR song **MUST** force the elevation to zero. The position is channel state: it persists across rows and is inherited by NNA ghosts and metainstrument layer children, exactly as `S $80xx`'s does.

### 4 $eeaa — Set target for spherical panning slide

**Plain.** In spatial surround mode, this command positions a sound source sliding target using azimuth and elevation, where azimuth 0°..360° maps to $00..$FF. Elevation is stored as a signed 8-bit integer, where −128 represents −90° and +127 represents approximately +90°. Use command `Z $0xxx` to initiate sliding.

**Compatibility.** Unique to Taud.

**Implementation.** Argument decoding is identical to X's, and the same stereo-model and planar-elevation rules apply. The target is CHANNEL state, not row state: it outlives the row that set it, so one `4` can serve many `Z` rows. Until a `4` is issued the target **MUST** equal the channel's own start position (front, $80, at song start), which makes a stray `Z` a no-op rather than a jump.

### Z $0xxx — Start spherical panning slide

**Plain.** Slides the spherical panning by speed `$xxx`. The speed rate is 1/16 of an azimuth unit per tick (see effect `X $eeaa`). `Z 0000` continues the slide by reusing the previously specified slide speed. If the start and target directions are identical, nothing **MUST** happen. If the start and target directions are antipodal, the interpolation path is implementation-defined.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent. The effect has its own memory slot, and only this form of `Z` touches it: the opcode multiplexes on its first nibble the way `S` does, and `Z $Ffxx` is funk repeat, a sampler command that is live in every song.

**Implementation.** Convert the start and target azimuth/elevation to unit direction vectors. An implementation **MUST** interpolate the source position along the shortest great-circle path at constant angular velocity. Quaternion-based SLERP using minimal-rotation quaternions is the **RECOMMENDED** implementation.

The slide is armed per row like every other tracker slide: it steps on each NON-FIRST tick of the row carrying the `Z`, and a row without one does not move the source. One step is `$xxx / 16` azimuth units of effect X (i.e. `$xxx / 8` of the 9-bit `S $8xxx` units), clamped so the source lands exactly on the target instead of overshooting; once there, further steps do nothing. The reference engine resolves the antipodal case CLOCKWISE, matching effect P.

## Volume column effects

Each cell carries a 6-bit value field plus a 2-bit selector field for the volume column. **All four selectors target `note_vol`** — the per-note volume axis (§3, analog of IT's `chan->volume`). The per-channel axis (`channel_vol`) is reachable only via the M / N effects in the main effect column. The four selectors are:

- **`0.$xx` — Set note_vol** to `$xx` (6-bit, $00..$3F). Equivalent in effect to seeding the note with a different default volume; persists across rows until the next re-trigger.
- **`1.$xx` — note_vol slide up** by `$xx` per non-first tick (4-bit). Clamps at $3F. The slid value persists into following rows.
- **`2.$xx` — note_vol slide down** by `$xx` per non-first tick (4-bit). Clamps at $00. The slid value persists into following rows.
- **`3.$Sx` — Fine note_vol slide** on tick 0 only. The high bit `$S` of the value selects direction (0 = down, 1 = up); the low 4 bits `$x` ($0..$F) are the magnitude. Equivalent in scale to `D $xF00` / `D $Fy00` but with a 5-bit cap. Fires once per row regardless of speed.

Volume-column effects do not consume the main effect slot; a cell can carry both (for instance, a tone portamento in the effect slot and a volume slide in the volume column). Because the volume column writes the per-note axis, an `M $xx00` on the same or following row sets the per-channel axis independently — the two multiply at the mixer (see §3 / §M).

When the converter folds an ST3 K, L, M, or N effect into the volume column, the slide-up / slide-down nibbles map to selectors 1 / 2 (clamped to 6 bits — values above $3F clip). Note that *converted* M and N still target `note_vol` here (vol-col semantics) — to preserve the original per-channel intent, converters **MUST** emit them in the main effect column instead.

**The ceiling is 63, and ScreamTracker's is too.** ST3's volume column and `Cxx` are documented as 0…64, and the editor shows 64 as full, but the value is carried in six bits and the player clamps it: `C40` sounds at 63, exactly as `C3F` does. Taud's `$00..$3F` is therefore the same dynamic range as the format it descends from, not a range short of one step — a converter that rescales by 63/64 to "fit" only pulls every volume in the song down. Clamp `$40` to `$3F` and leave every other value alone. The same reading applies to XM and IT sources, whose 0…64 columns are the same six bits with the same clamp.

NOTE: **`3.00` — is No-op**

## Panning column effects

The panning column uses the same 6-bit value + 2-bit selector layout. **All four selectors target `note_pan`** — the per-note panning axis (§3a), the exact counterpart of the volume column owning `note_vol`. The per-channel axis (`channel_pan`) is reachable only via S $80xx / P / X / 4 / Z in the main effect column.

- **`0.$xx` — Set note_pan** (6-bit, $00..$3F mapped onto the 8-bit pan space; $01 = full left, $1F = centre-left, $20 = centre-right, $3F = full right), read as an offset from centre. It **replaces** whatever the instrument seeded, so it is the way to pan one note of a zone-panned Ixmp instrument by hand. For 8-bit precision use a wide cell's panning column.
- **`1.$xx` — note_pan slide right** by `$xx` per non-first tick (4-bit).
- **`2.$xx` — note_pan slide left** by `$xx` per non-first tick (4-bit).
- **`3.$Sx` — Fine note_pan slide** on tick 0 only, same direction-bit encoding as the volume column's selector 3.

Because the column writes the per-note axis, an `S $80xx` on the same or a following row moves the per-channel axis independently and the two add at the mixer (§3a) — there is no precedence between them, and an engine **MUST NOT** suppress either when both appear on one row. The column is applied AFTER the row's note trigger, so a SET sharing a row with a note wins over that note's instrument seed.

NOTE: **`3.00` — is No-op**

## Effects that modifies global behaviour

Effects in this section modifies the behaviour of the mixer. Primary intention of the commands is to provide switches for legacy tracker and modern DAW behaviours.

### 1 $xx00 — Global behaviour flags

**Plain.** Sets mixer-wide behaviour flags. Available flags are:

    0b 000 rrr ff

- ff = 0: Linear tone mode. Pitch shift will behave like MIDI/ImpulseTracker. **Coarse and fine E/F arguments are stored as 4096-TET pitch units** and subtracted/added directly from the stored pitch.
- ff = 1: Amiga (cycle-based) tone mode. Pitch shift will behave like ProTracker/ScreamTracker. **Coarse and fine E/F arguments are stored as raw tracker period units** (the unscaled byte/nibble from the source PT/S3M/IT file) and applied in Amiga period space. Tone portamento (G) remains linear regardless of mode.
- ff = 2: Linear-frequency tone mode (MONOTONE compat). **E, F, and G arguments are stored as Hz/tick** (a signed change in audible frequency per song tick), and the engine converts the channel's stored 4096-TET pitch back to a frequency, adds/subtracts the argument, then converts back to 4096-TET. Reference is fixed at 12-TET A4 = 440 Hz / C4 ≈ 261.6256 Hz, which matches MONOTONE's MT_PLAY.PAS `notesHz` table (A0 = 27.5 Hz, equal-temperament). Unlike Amiga mode, *all three* slide effects use the new arithmetic — Monotone's `1xx`, `2xx`, and `3xx` are all in Hz/tick (see MTSRC/MT_PLAY.PAS:606-630).

- rrr = 0: Yes interpolation. The actual interpolation algorithm is implementation-dependent; Fast Sinc or Linear is **RECOMMENDED**.
- rrr = 1: No interpolation.
- rrr = 2: Amiga 500 interpolation.
- rrr = 3: Amiga 1200 interpolation.
- rrr = 4: SNES 4-tap gaussian.
- rrr = 5: NES DPCM simulation.

## ProTracker to Taud conversion table

This table maps each PT effect to its Taud equivalent. Arguments follow PT's two-nibble form and expand to Taud's 16-bit form as shown.

| PT effect | Taud effect | Notes |
|---------|---------|-------|
| `0 $xy` | `J $xxyy` | Arpeggio; nibble-repeat each byte. See the 12-TET → Taud table above for conversion losses |
| `1 $xx` | `F $00xx` (Amiga mode, `f` set) | Portamento up; raw PT period units, applied in period space |
| `2 $xx` | `E $00xx` (Amiga mode, `f` set) | Portamento down; raw PT period units, applied in period space |
| `3 $xx` | `G round($0xxx × 64/3)` | Portamento to note; G is always linear (4096-TET units) regardless of mode |
| `4 $xy` | `H $xxyy` | Vibrato; nibble-repeat each byte. |
| `5 $xy` | `L $xy00` | Combined portamento + volume slide; argument byte verbatim (PT `500` recall is resolved to the previous 5xy by the converter, then emitted as L $xy00) |
| `6 $xy` | `K $xy00` | Combined vibrato + volume slide; argument byte verbatim (PT `600` recall is resolved to the previous 6xy by the converter, then emitted as K $xy00) |
| `7 $xy` | `R $xxyy` | Tremolo; nibble-repeat |
| `8 $xx` | `S $80xx` or panning column `0.$xx` | Fine pan |
| `9 $xx` | `O $xx00` | Sample offset |
| `A $xy` | Vo ume column `1.$xy` | Volume slide |
| `B $xx` | `B $00xx` | Position jump |
| `C $xx` | Vo ume column `0.$xx` | Set volume |
| `D $xx` | `C $00xx` (after BCD decode) | Pattern break |
| `E $0x` | `S $0x00` | Set low-pass filter |
| `E $1x` | `F $F00x` (Amiga mode, `f` set) | Fine pitch slide up; raw PT period units, applied in period space at tick 0 |
| `E $2x` | `E $F00x` (Amiga mode, `f` set) | Fine pitch slide down; raw PT period units, applied in period space at tick 0 |
| `E $3x` | `S $1x00` | Glissando control |
| `E $4x` | `S $3x00` | Vibrato waveform |
| `E $5x` | `S $2x00` | Set fine-tune |
| `E $6x` | `S $Bx00` | Pattern loop |
| `E $7x` | `S $4x00` | Tremolo waveform |
| `E $8x` | `S $80xx` or panning column `0.$xx` | Coarse pan (nibble-repeat) |
| `E $9x` | `Q $0x00` | Retrigger |
| `E $Ax` | Volume column `3.$1x` | Fine volume slide up |
| `E $Bx` | Volume column `3.$0x` | Fine volume slide down |
| `E $Cx` | `S $Cx00` | Note cut |
| `E $Dx` | `S $Dx00` | Note delay |
| `E $Ex` | `S $Ex00` | Pattern delay |
| `E $Fx` | `S $F0yy` (invert loop) | The byte is ambiguous — PT 1.0 meant Funk Repeat, PT 1.1B onwards Invert Loop — so emit the invert loop, which is the one every player since implements. `Z $F0yy` is Funk Repeat, for modules known to predate 1.1B. `yy = funk_table[x]` either way |
| `F $xx` (xx < $20) | `A $xx00` | Set speed |
| `F $xx` (xx ≥ $20) | `T $(xx−$18)00` | Set tempo |

## Miscellaneous implementation details

This section documents important implementation details that are not covered by sections above.

### Volume fadeout

Taud's volume fadeout is a single linear decay applied per song tick after key-off (or NNA Note-Fade). It is **the only retirement mechanism** for sustained voices when the volume envelope holds non-zero or has no terminating zero node — without a non-zero stored fadeout, such voices play forever.

The 12-bit stored fadeout lives at instrument-record bytes 172 (low 8 bits) and 173 (low nibble = high 4 bits; high nibble reserved). Range 0..4095. The engine **MUST** maintain a per-voice `fadeoutVolume ∈ [0, 1]` initialised to 1.0 on note-on, and once per song tick while the voice is keyed off **MUST**:

```
fadeoutVolume -= storedFadeout / 1024.0
clamp fadeoutVolume to [0, 1]
if fadeoutVolume == 0: voice deactivates
```

Boundary semantics:

| `storedFadeout` | Behaviour |
| --- | --- |
| `0` | No fade. Voice plays at envelope-driven volume indefinitely. |
| `1..1023` | Graduated fade — completes in `1024 / storedFadeout` ticks. |
| `1024` | Exact 1-tick cut. The canonical "kill on key-off" value. |
| `1025..4095` | Also a 1-tick cut (clamped at 0). Headroom for converter robustness. |

There is no separate "use fadeout" flag — both extremes share the same field, exactly as in the IT and XM file formats.

**Tick-rate worked example** (default 50 Hz, BPM 125, speed 6):

- `storedFadeout = 1` → fade ≈ 20.5 s
- `storedFadeout = 32` → fade ≈ 640 ms
- `storedFadeout = 1024` → ~20 ms (one tick)

**Converter unit conversion.** Source trackers each expose fadeout in their own unit; converters **MUST** scale the source value into Taud's 0..4095 field.

- **IT** (`it2taud.py`): IT files store fadeout as a 16-bit field at instrument-record offset `$14`, range 0..1024 per ITTECH (some loaders accept up to 2048). Schism's per-tick decrement is `stored / 1024` — identical to Taud's unit. **Pass-through with clamp:**
  ```python
  taud_fadeout = min(it_fadeout & 0xFFFF, 0x0FFF)
  ```
- **FT2 / XM** (`xm2taud.py`): XM files store fadeout as a 16-bit field. Spec range 0..$FFF; MilkyTracker writes up to 32767 to encode the "cut" UI slider position (`SectionInstruments.cpp:499-500`). FT2's per-tick decrement is `stored / 32768` — to match Taud's `stored / 1024` rate, **divide source by 32 (round-to-nearest):**
  ```python
  taud_fadeout = min((xm_fadeout + 16) // 32, 0x0FFF)
  ```
  XM stored 1..15 round to Taud 0; the originals were >11 min at 50 Hz — effectively no-fade anyway. Stored 32 → Taud 1 (~20 s). Stored 32767 (Milky cut sentinel) → Taud 1024 (1-tick cut).
- **MOD / S3M / MON**: source has no instrument-level fadeout. Converter writes Taud `0`. Notes retire on sample-end or pattern note-cut.

**Implementation.**
- Panning (equal-energy):
  - L_gain = cos(πx / 512.0)
  - R_gain = sin(πx / 512.0)
- Amiga tone (both coarse and fine E/F pitch slides). The `slideArg` is a **raw tracker period-unit count** (no scaling), with sign matching linear mode (negative for E, positive for F). Coarse slides apply on every non-first tick; fine slides apply once on tick 0 — the per-step arithmetic is identical:
  - AMIGA_BASE_PERIOD = 428.0  (period at the Taud reference pitch C4 for a standard 8363 Hz instrument, NTSC clock — identical to PT "C-2" period 428)
  - period = AMIGA_BASE_PERIOD × 2^(−(noteVal − C4) / 4096)
  - period_new = period − slideArg                     (E subtracts pitch ⇒ adds period; F adds pitch ⇒ subtracts period)
  - noteVal_new = C4 + 4096 × log2(AMIGA_BASE_PERIOD / period_new)
- Linear-frequency tone (E / F / G in Hz/tick). The `slideArg` is a **signed Hz delta per tick** at the audible reference 12-TET A4 = 440 Hz / C4 ≈ 261.6256 Hz, identical to the value MONOTONE stores in its 1xx/2xx/3xx commands. Sign convention matches linear/Amiga modes (negative for E, positive for F):
  - LINEAR_FREQ_C4_HZ = 261.625565...  (12-TET, so A4 = 440 Hz exactly)
  - freq = LINEAR_FREQ_C4_HZ × 2^((noteVal − C4) / 4096)
  - freq_new = max(freq + slideArg, 1.0)
  - noteVal_new = C4 + 4096 × log2(freq_new / LINEAR_FREQ_C4_HZ)
  - For tone portamento (G), `tonePortaSpeed` is also in Hz/tick: each tick walks `freq` toward `noteValToFreq(target)` by `±tonePortaSpeed` until the target frequency is reached.
  - Like Amiga mode, the per-voice intermediate frequency is cached across ticks (no round-trip rounding) and reseeded on note trigger, `S $2x` finetune, fine slides, and the start of a fresh multi-tick coarse slide.

**Initialisation from the song table.** The same flags byte is stored in the song-table entry (see file format §Song Table). A Taud player **MUST** write this byte to MMIO playhead register 7 before starting playback; the mixer then applies it as the initial state on every reset, and subsequent in-pattern `1` effects **MAY** override it.

End of reference.
