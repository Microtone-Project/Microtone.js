# Microtone Sketch File Format Specification

This document defines the **sketch** file, `.mtsk` — the document of **Microtone Touch**, the phone sketchpad that sends its ideas on to Microtone. A sketch is small on purpose: it stands for exactly one Taud song, and it leaves out everything about that song a sketch cannot change. There is no sample or instrument image (every conforming application carries the same instrument pack, [§5](#5-the-instrument-pack)), no song table (lanes, speed and mixing are fixed) and no cue sheet (sections play in order). What remains is a 32-byte header, the pattern images of up to sixteen sections compressed as one blob, and a few Project-Data blocks — a few hundred bytes to a few kilobytes, where the equivalent `.taud` is around seventy kilobytes before the first note.

Companion documents: the **Taud File Format** defines the pattern cell and the Project-Data container this file reuses; the **Taud Engine Specification** defines how the song a sketch stands for is played.

- **Created** by CuriousTorvald, 2026-10-03.
- **Endianness** — little, everywhere, without exception.
- **Character encoding** — as in the Taud File Format: UTF-8 for Project-Data strings, raw bytes for fixed-width fields.

## Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY** and **OPTIONAL** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals and bold. Lowercase uses carry their ordinary English meaning and impose no requirement.

- **MUST** / **MUST NOT** / **REQUIRED** / **SHALL** / **SHALL NOT** — absolute requirements and prohibitions. A conforming implementation **SHALL** observe every such rule; one that violates any is non-conforming.
- **SHOULD** / **SHOULD NOT** / **RECOMMENDED** / **NOT RECOMMENDED** — strong guidance. An implementation **MAY** deviate in particular circumstances, but the full implications **MUST** be understood and weighed before doing so.
- **MAY** / **OPTIONAL** — truly optional. Implementations that include the feature and implementations that omit it are equally conforming, and each **MUST** be prepared to interoperate with the other.

Four further terms classify malformed or unused encodings:

- **INVALID.** Blame the encoder. A decoder **MUST** stop decoding and report an error.
- **UNDEFINED BEHAVIOUR.** An encoder **MAY** produce it; a decoder **MAY** do anything in response.
- **IGNORED.** An encoder **MAY** produce it; a decoder **MUST** skip past it without complaint.
- **RESERVED.** An encoder **MUST NOT** produce it; a decoder **MUST** skip past it.

Field tables use the Taud File Format's type names: `U8`/`U16`/`U32` for unsigned integers, `F32` for IEEE 754 binary32, and `Byte[n]` for a raw run of *n* bytes.

## 1. File structure

```
\x1F M T s k e c h
[HEADER]                 32 bytes total, including the magic
[PATTERN BLOB]           compressed; sections A…P, always all sixteen
[PROJECT DATA]           optional; FourCC-tagged blocks
```

The pattern blob begins immediately after the header, at offset 32, and runs to the Project-Data offset — or to the end of the file when there is no Project Data. Its compressed size is therefore implied, never stored.

### Compression

The pattern blob is compressed exactly as a Taud payload is ([Taud File Format §1](TAUD_FILE_FORMAT.md#compression)): a self-contained gzip (`1F 8B 08`) or Zstandard (`28 B5 2F FD`) stream, identified by its own leading magic.

- An encoder **MAY** use either codec, at any level.
- A decoder **MUST** support both, and **MUST** sniff the magic rather than assume one.

Microtone Touch writes gzip at level 9: a phone has it at hand, and on a sketch's patterns Zstandard saves only a kilobyte or so.

## 2. Header

Fixed 32 bytes, always at file offset 0 — the same size as a Taud header, though the fields differ.

| Offset | Type | Field |
|---|---|---|
| 0 | `Byte[8]` | Magic — `1F 4D 54 73 6B 65 63 68` (`\x1FMTskech`) |
| 8 | `U8` | Format version — 1 |
| 9 | `U8` | Song flags ([below](#song-flags-byte-9)) |
| 10 | `U8` | Feature flags ([below](#feature-flags-byte-10)) |
| 11 | `U8` | BPM, low 8 bits ([Tempo](#tempo)) |
| 12 | `U16` | Notation index, as in a Taud `sMet` entry ([Taud File Format §9.6](TAUD_FILE_FORMAT.md#9-6-smet-song-metadata-table)) |
| 14 | `U32` | Absolute offset to Project Data; 0 when absent |
| 18 | `Byte[14]` | Encoder signature, space-padded |

A file whose magic does not match is **INVALID**. A decoder that does not recognise the format version **MUST** stop rather than guess; version 1 is the only one assigned.

### Song flags (byte 9)

```
0b ssss 000r
```

| Bits | Field | Values |
|---|---|---|
| `r` (0) | Loop | Set: the song jumps back to section A when its last section ends. Clear: it stops there |
| 1…3 | — | **RESERVED** |
| `ssss` (4…7) | Sections | The number of sections in the song, **minus one**: 0 = section A alone, 15 = A through P |

The count is stored rather than inferred from the patterns, so a section that is deliberately empty — a rest before the song loops — is kept even when it is the last.

### Feature flags (byte 10)

```
0b 0000 ttpp
```

| Bits | Field | Values |
|---|---|---|
| `pp` (0…1) | Tempo | Bits 8 and 9 of the stored BPM ([Tempo](#tempo)) |
| `tt` (2…3) | Tuning | 0 = A4 (`$5C00`) @ 440 Hz, 1 = C4 (`$5000`) @ 262 Hz, 2 = C4 (`$5000`) @ 311 Hz, 3 = the `tune` block ([§4.3](#4-3-tune-tuning-declaration)) |
| 4…7 | — | **RESERVED** |

The three named declarations are concert pitch, the modern Chinese *a-ak* convention and the Korean *hyang-ak* standard — the same pairs the Taud File Format lists under [Tuning](TAUD_FILE_FORMAT.md#tuning), and between them every tuning Microtone Touch offers. Code 3 with no `tune` block in the Project Data is **INVALID**.

### Tempo

The stored BPM is the ten-bit value `pp` × 256 + byte 11, biased by −25 exactly as a Taud song table's is: the tempo in beats per minute is that value plus 25, from 25 to 1048.

A `.taud` song table holds the same ten bits, 25…1048 ([Taud File Format §4](TAUD_FILE_FORMAT.md#4-song-table)), so a converter to Taud carries the tempo across unchanged.

### Signature

Fourteen bytes naming the encoder, used for diagnostics only and otherwise **IGNORED**. Microtone Touch writes `MicrotoneTouch`.

## 3. Pattern blob

The blob decompresses to exactly **65 536 bytes**, whatever the sketch holds. Any other length is **INVALID**. It is 128 pattern images of 512 bytes each — 64 rows of the 8-byte cell of [Taud File Format §5](TAUD_FILE_FORMAT.md#pattern-cell) — back to back:

```
pattern number  =  8 × section + lane
section         =  0 (A) … 15 (P)
lane            =  0 … 7
```

A sketch has **eight lanes** and up to **sixteen sections**. A section is one 64-row stretch of the song with one pattern on each lane, so the blob holds every pattern any sketch can have, at a fixed place. A decoder can allocate it before decompressing, and the pattern an edit touches never moves.

Every cell has its Taud meaning, unchanged: the note word with its sentinels (key off, note cut and the rest), the volume and panning columns, the effect opcode and its argument. A sketch is played by playing these cells ([§6](#6-playing-a-sketch)), so nothing about a cell is specific to sketches — except the **instrument byte**, which selects a slot of the instrument pack ([§5](#5-the-instrument-pack)). As in Taud, 0 means "no instrument change".

The patterns of sections past the song's count are **IGNORED**. An encoder **SHOULD** fill them with empty cells — note `$0000`, instrument 0, both columns `$C0`, no effect, the bytes `00 00 00 C0 C0 00 00 00` — so that they cost almost nothing once compressed.

## 4. Project Data

The Taud Project-Data container, unchanged ([Taud File Format §9](TAUD_FILE_FORMAT.md#9-project-data)):

```
Byte[8]  Magic — \x1E T a u d P r J  (1E 54 61 75 64 50 72 4A)
Byte[8]  RESERVED
* repetition of:
  Byte[4]  Block FourCC
  U32      Block payload length
  Byte[*]  Payload
```

- When the header's Project-Data offset is non-zero, it **MUST** point past the header and at this magic, inside the file; otherwise the file is **INVALID**.
- Every block **MUST** lie wholly inside the file; a block that runs off the end is **INVALID**.
- Blocks **MAY** appear in any order. A block whose FourCC the decoder does not recognise is **IGNORED** — its length field says how far to skip. Duplicate blocks are **UNDEFINED BEHAVIOUR**.
- An encoder **SHOULD** omit Project Data entirely when there is nothing to put in it: a sketch with no name, on one of the three named tunings, needs none.

Three blocks are defined.

### 4.1 `PNam` — the sketch's name

As in a `.taud` ([Taud File Format §9.2](TAUD_FILE_FORMAT.md#9-2-pnam-pcom-pcpr-pmsg-project-strings)): one string, the terminating `NUL` **OPTIONAL**, a reader stopping at the first `NUL` when there is one. Microtone writes every character outside ASCII as a `\uHHHH` escape — uppercase hexadecimal, one per UTF-16 code unit — as it does in every name a `.taud` holds, and resolves the escapes for display. A reader **SHOULD** do the same, so the block can be copied into a `.taud` byte for byte.

### 4.2 `nota` — custom notations

As in a `.taud` ([Taud File Format §9.7](TAUD_FILE_FORMAT.md#9-7-nota-custom-notation-definitions)). A header notation index in 65520…65535 names one of the notations this block defines; with no matching definition, a reader **SHOULD** fall back to 12-TET display, as a Taud reader does.

### 4.3 `tune` — tuning declaration

| Offset | Type | Field |
|---|---|---|
| 0 | `U16` | Base note — a 4096-TET note word, 1…65533 |
| 2 | `F32` | Frequency in Hz at the base note, finite and above 0 |

Read only when the header's tuning code is 3; under any other code the block is **IGNORED**. A base note or frequency outside those ranges is **INVALID**. The pair means what a Taud song table's tuning pair means: "note *N* sounds at *F* Hz" ([Taud File Format §4](TAUD_FILE_FORMAT.md#tuning)).

## 5. The instrument pack

A sketch carries no instruments. Every conforming application **SHALL** embed the **Microtone Touch instrument pack**, and the instrument byte of a pattern cell selects one of its slots:

| Slot | Instrument | | Slot | Instrument |
|---|---|---|---|---|
| 1 | Piano | | 8 | Kick |
| 2 | Electric piano | | 9 | Snare |
| 3 | Bass | | 10 | Closed hat |
| 4 | Pluck | | 11 | Open hat |
| 5 | Lead | | 12 | Clap |
| 6 | Pad | | 13 | Low tom |
| 7 | Organ | | 14 | High tom |
| | | | 15 | Rim |

Slots 16…255 are **RESERVED**: an encoder **MUST NOT** write them, and they play as an empty instrument record does — silence.

The pack is defined by a file: **`MicrotoneTouch.tsii`**, published beside this document. It is an ordinary `.tsii` ([Taud File Format §8](TAUD_FILE_FORMAT.md#8-tsii-and-tpif)): its sample and instrument image is the pack, and its `INam` table names the slots above. An application **MAY** build the pack some other way — Microtone and Microtone Touch both synthesise it at start-up, which is why it is never downloaded — but what it builds **MUST** be that image, byte for byte.

The pack belongs to the format version. Its slots **MUST NOT** be renumbered, and an instrument **MUST NOT** change how it sounds within a version, because every sketch ever written plays through it. Adding a slot, or revising a sound, is a new format version and a new `.tsii`.

## 6. Playing a sketch

A sketch **is** the Taud song below: a player **MUST** play it as that song, and a converter to `.taud` **MUST** produce it. Microtone opens a sketch as a new project holding exactly this song, and Microtone Touch's own transport plays the same song, so a sketch sounds the same in both.

The song's table entry ([Taud File Format §4](TAUD_FILE_FORMAT.md#4-song-table)):

| Field | Value |
|---|---|
| Lanes | 32 — lanes 0…7 carry the sketch, the rest stay empty |
| Patterns | `8 × sections`: patterns 0 … `8 × sections − 1` of the blob, in blob order |
| BPM | The header's tempo ([Tempo](#tempo)) |
| Tick rate | **6** — a sketch has a tempo, not a speed |
| Tuning | The header's declaration ([Feature flags](#feature-flags-byte-10)) |
| Global behaviour flags | 0 — linear slides, the default interpolation |
| Global volume / mixing volume | `$80` / `$80` |
| Surround model | 0 — stereo |

The cue sheet has one cue per section, in order. Cue *s* names pattern `8s + lane` on lanes 0…7 and `$7FFF` (no pattern) on lanes 8…31. Every cue's instruction words are NOP, except that the **last** cue carries **JMP 0** in instruction word 0 when the loop flag is set and **HALT** when it is clear ([Taud File Format §6.2](TAUD_FILE_FORMAT.md#6-2-instruction-words)).

The sample and instrument image is the pack's ([§5](#5-the-instrument-pack)). The song's Project Data carries:

| Block | Contents |
|---|---|
| `PNam` | The sketch's `PNam`, when it has one, byte for byte |
| `INam` | The pack's instrument names |
| `sMet` | One entry for song 0: the header's notation index, beat divisions 4 and 16, the sketch's name as the song name, no composer, no copyright |
| `nota` | The sketch's `nota`, when it has one, byte for byte |

## 7. How Microtone Touch writes a sketch

*This section is informative: it describes one encoder, and a file that does otherwise is no less valid.*

Each lane holds **one** preset — one of slots 1…7, or the drum kit, slots 8…15 — and every note on the lane carries that slot, or the kit piece it was played on. A cell holds a note, a key off (`$0001`) or nothing. Both columns of every row are `$C0`, so Touch never sets a volume or a pan.

A note may carry one of four effects, at one of three strengths. In Touch an effect **lasts**: it runs from its note until the lane's next note or key off. Taud's effects act only on the rows that carry them, so Touch writes the command again on every row of that run — what a tracker user would have typed by hand.

| Touch calls it | Light | Medium | Strong |
|---|---|---|---|
| Slide — tone portamento | `G $0040` | `G $0100` | `G $0400` |
| Vibrato | `H $7120` | `H $7140` | `H $7180` |
| Roll — retrigger every 3, 2 or 1 ticks | `Q $0300` | `Q $0200` | `Q $0100` |
| Fade — volume slide down by 1, 2 or 4 a tick | `D $0100` | `D $0200` | `D $0400` |

Reading a sketch back, Touch takes each lane's preset from the slot of its first note (an empty lane keeps Touch's default), and each note's effect from the command on the note's own row. What its model cannot hold — other sentinels, a volume or pan column, any other effect — it leaves behind rather than misread.

## 8. Online storage

Sketches are made to be kept by the dozen. An online storage service that keeps sketches **SHOULD** provide at least **64** sketch slots per account, separate from any slots it keeps for `.taud` projects, so that sketching never crowds out the songs being finished.

Whatever a sketch holds, its patterns are 65 536 bytes before compression, and a compressed stream of incompressible input is barely longer. A per-sketch ceiling of 128 KiB therefore refuses no sketch an encoder writes, short of an enormous custom notation, and 64 full slots stay within 8 MiB per account.

Microtone's own online storage keeps sketches under names ending in `.mtsk`, in 64 slots per account of up to 128 KiB each, beside the account's project slots. The extension decides which kind of slot a file is in: a sketch slot accepts only a file with this format's magic, and a rename keeps the extension.

## 9. Validity checklist

A writer producing a file that any conforming reader will accept must satisfy all of the following.

- The magic matches, and the format version is 1.
- Song-flag bits 1…3 and feature-flag bits 4…7 are 0.
- The pattern blob is gzip or Zstandard, and decompresses to exactly 65 536 bytes.
- `Project Data offset` is 0 if and only if there is no Project Data; when it is not 0, it lies past the header and points at the `\x1ETaudPrJ` magic.
- Every Project-Data block lies wholly inside the file, and no FourCC appears twice.
- Tuning code 3 comes with a `tune` block whose base note is 1…65533 and whose frequency is finite and above 0.
- No pattern cell's instrument byte is above 15.

## 10. Version history

| Date | Change |
|---|---|
| 2026-10-03 | Format created: version 1, and with it the instrument pack's fifteen slots |
