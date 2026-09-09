# Microtone User Manual

***Microtone™*** is a microtonal music tracker for the TSVM **Taud** format that
runs entirely in your browser. There is no server component: your files never
leave your machine, projects are stored in the browser's private storage, and
even MIDI/module conversion happens locally. The audio engine is a faithful
port of the TSVM Taud engine — a ScreamTracker 3-lineage tracker extended with
16-bit effect arguments and a 4096 tone-equal temperament pitch grid. It renders
**48 kHz** stereo, which is the rate browsers run their audio at, so what you
hear and what you export leave the engine untouched by any resampling stage.
(Hardware that insists on another rate — 44.1 kHz laptops — and exports at any
other rate go through a band-limited Kaiser-sinc resampler, the same kernel the
Sample Lab uses, rather than losing the top octave to a cheaper conversion.)
(The TSVM device itself is a 32 kHz machine, and the 8-bit dithered character
its output stage gives the format is intentional and unchanged — everything
rate-derived, from tick length to the Amiga filters, is computed for whichever
rate the engine is running at, so a song plays and sounds the same on both.)

> Press **?** in the app (or the **?** button in the top bar) at any time for a
> compact keyboard reference. The full effect-command specification lives in
> the **Note Effects** document in the sidebar, and what changed in each build
> is listed under **Patch Notes** (also linked from the About popup).

> Looking for the specifications rather than the manual? The sidebar also
> carries the three Taud reference documents: **Engine Spec** (how playback
> works — timing, envelopes, voices, filters, mixing), **File Format** (the
> `.taud`) and **Conversion Notes** (how
> MOD, S3M, XM, IT, MON and MIDI files map onto Taud, and where they lose
> something on the way).

## Introduction

### Tracker concepts

If you have used Impulse Tracker, Schism Tracker or OpenMPT, you will feel at
home. If not, here is the vocabulary this manual uses:

| Term | Meaning |
|---|---|
| **Channel / voice** | One monophonic playback lane. A song has 32 or 64 channels. |
| **Pattern** | A 64-row grid of cells for **one** channel. Unlike most trackers, a Taud pattern is single-channel. |
| **Row** | One line of a pattern. Each row holds a note, an instrument, a volume, a pan and an effect. |
| **Tick** | The engine's time slice. Each row lasts *speed* ticks; effects update per tick. |
| **Cue** | One entry of the song's order list: for every channel, which pattern plays next, plus optional flow commands (jump, halt, length…). A song is a sequence of cues. |
| **Instrument** | A playable definition: a sample plus envelopes, filter, panning, NNA rules — or a **metainstrument**, which holds a table of other instruments instead of a sample. |
| **Metainstrument** | The family, and it has two kinds: a **Layered** metainstrument sounds its instruments side by side, an **FM Rack** wires them into each other. Both live in an ordinary instrument slot and are played by an ordinary pattern cell. |
| **Sample** | Raw 8-bit audio data in the shared sample pool. Several instruments may use the same sample. |
| **Note word** | A 16-bit pitch value; see the pitch system below. |

### The pitch system: 4096-TET

Every note is a 16-bit word on a grid of **4096 steps per octave** — fine
enough to represent any practical tuning. `0x5000` is middle C (C4) and each
`0x1000` is one octave. Values `0x0000`–`0x001F` are reserved for sentinels
(key-off, note cut, fades) and interrupts.

You almost never type raw note words. Instead each song carries a **pitch
table** (a notation preset such as 12-TET, 19-TET, 31-TET, Bohlen-Pierce…)
and the editor snaps entry, display and stepping to that table's degrees. See
[Microtonality in depth](#microtonality-in-depth).

## Getting started

### Opening and creating projects

- **Drop a file anywhere** on the window, or use **Open…** in the top bar. `.taud` (full project) is the native format of the Microtone. Tracker modules (`.mod`, `.s3m`, `.xm`, `.it`, `.mon`) and AdLib songs (`.ims`) are converted on the fly.
- **Import MIDI…** converts a `.mid` file through a SoundFont — see [Importing music](#importing-music).
- **New…** opens the New Project wizard, which collects every song setting before the blank project is built:
  - **Tempo** — BPM (25–535) and speed (ticks per row, 1–127), with a live *blinkenlights* strip previewing the feel of that tempo.
  - **Meter** — a time signature and rows-per-beat. These set the two beat divisors (rows/beat and the derived rows/bar) that colour the row highlighting; the **Row highlight** preview shows exactly how the Timeline gutter will band.
  - **Tuning** — the reference base note (C4 or A4) and its frequency.
  - **Metadata** — song name, composer and copyright.
  - **Layout** — 32 or 64 channels.
  - **Notation** — the display pitch table (12-TET, 24-TET, 31-TET, Bohlen-Pierce…), defaulting to **24-TET**. You can change it later in the Project view.

A new project has no samples. Add instruments later from the Instruments view.

### Demo songs

The welcome screen (the Timeline tab before anything is loaded) lists the
**demo songs** bundled with Microtone, and **Demo songs…** in the File view
reaches the same list once you have a project open. Loading one replaces what
is open, exactly as opening a file would; nothing is written to browser storage
unless you save it yourself.

A demo is a whole project, samples and all — open it, play it, and take it
apart. The composer's own note on the piece is usually in the project
**Message**, in the [Project](#project-f7) view.

Demo songs are included with the permission of their composers and keep their
own copyright; they are not covered by Microtone's licence.

The app warns before discarding unsaved changes, and autosaves your work — see
[Saving and autosave](#saving-and-autosave).

### Playing

| Control | Action |
|---|---|
| **Enter** | Play from the cursor row / stop |
| **Shift+Enter** | Play from the start |
| **▶ Song** button | Play from the start |
| **▶ Cue** button | Play from the cue under the cursor |
| **follow** checkbox | Scroll the view with playback |

Audio starts in a suspended state (browsers require a user gesture before
sound); the first click or key press activates it — the badge in the top bar
shows `audio @ … Hz` once running. Jamming on the piano keys works immediately,
without pressing Play.

### The screen at a glance

From top to bottom:

- **Top bar** — transport, record toggle, undo/redo, octave / instrument / speed displays (hover and use the mouse wheel to change them), song selector, file buttons, language / theme / help buttons. Click the **Microtone** logo for the About box.
- **Tabs** — the eight views, on **F1**–**F7** and **F9**. The strip belongs to the pane below it, so a split screen has one per pane, each ending in the button that splits the view (**⊞**) or closes that pane (**✕**).
- **Toolbox** (Timeline and Patterns only) — **Retune…**, the **Raw** hex-note toggle and the quick **Instruments** lookup panel.
- **The main view.**
- **Command palette** — a context strip above the status bar showing the actions and documentation for the column under the cursor while recording.
- **Status bar** — file name, project name, dirty marker, cue/row/BPM/speed position, and links to these docs.

## Views

| Key | View | Purpose |
|---|---|---|
| **F1** | Timeline | The whole song, all channels — main editing view |
| **F2** | Cues | The order list and flow commands |
| **F3** | Patterns | Single-pattern editor with bulk tools |
| **F4** | Samples | The sample pool: waveforms, DSP editing |
| **F5** | Instruments | The instrument bank: envelopes, zones, layers |
| **F6** | Mastering | The delivery chain and its meters |
| **F7** | Project | Song properties, tuning, song list |
| **F9** | File | Browser storage, import/export |

### Value controls

Every number field and dropdown in the panels is a value between two buttons:

    ┌─┬───┬─┐        ┌─┬───┬─┐
    │–│123│+│        │◄│abc│►│
    └─┴───┴─┘        └─┴───┴─┘

- **`–` / `+`** step the number, **`◄` / `►`** move through a list; hold either and it repeats, faster the longer you hold. An arrow greys out at the end of its list.
- **The middle is a real field.** Click it and type, or use **↑ / ↓** on a number; click a dropdown and its full list opens. The value sits centred between the two buttons, and shuffles left only when it is too long for the box — so what gets cut off is the end of it, never the start.
- **Hex is understood everywhere a number is.** Type `$FF` or `0xFF` into any spinner and it becomes 255 — handy when the annotation beside the field, the effect argument you are matching, or the pattern you are reading it off is written in hex. The box settles on the decimal it landed on, and `–` / `+` step from a hex value just as readily. A sign goes in front of either spelling (`-$10`). Anything that is not a number at all leaves the field as it was rather than quietly becoming zero.
- **Some fields read in one unit and step in another**, because the file stores something else. An envelope segment shows **seconds** and steps one storable length at a time; a metainstrument layer's mix shows **decibels** and steps one mix level, with the raw byte beside it; a layer's detune shows **cents** and steps a whole degree of the song's own notation. Typing works in whatever the box shows, and the value settles on the nearest one the file can hold.

### Two views at once

**F8** (or the **⊞** button at the end of the tab strip) splits the screen in
two, and every pane carries its own set of the eight tabs — Timeline against
Patterns, a pattern against the instrument it plays, the Cues list against the
song it orders.

- Which way it splits follows the shape of the screen: side by side while it is wider than tall, one above the other otherwise. Turning a tablet on its side re-splits it the other way by itself.
- **Drag the seam** between the panes to give one more room; double-click it to even them up again.
- The pane you last clicked in has the keyboard — its active tab is the one in the accent colour. **Shift+F8** moves to the other pane.
- **Both panes can show the same view**: two Timelines scrolled to different bars of the song, two Patterns views, two of anything. Each is a copy of its own, with its own scroll position and its own selection, and both edit the one document — a change in either shows up in the other at once. (**F1**–**F7** and **F9** never open a second copy of something already on screen: they take you to the pane that has it. Clicking the tab is how you ask for a second one.)
- **F8** again, or the pane's **✕**, closes it; the view in the other pane keeps the screen — including which bar it was scrolled to, so closing the pane you are working in leaves you where you were.
- The master strip (see [Timeline](#timeline-f1)) stays where it is down the right-hand edge, beside both panes, and is on screen whenever *either* pane shows the Timeline.

## Timeline (F1)

The Timeline unrolls the entire song: every channel side by side, every cue
stacked vertically. The left gutter — the *trough* — shows `cue:row` and selects
whole song rows; channel headers carry
live VU/pan meters, the channel's current pitch, and the name of the pattern while playing.

### Reading a cell

Each cell is five columns:

```
 C--4   01    3F   20  A0F00
└note┘└inst┘└vol┘└pan┘└─fx─┘
```

- **Note** — the pitch in the song's notation (or a sentinel symbol: `===` key-off, `^^^` cut, `~~~` fade, `~^~` fast fade). Notes that don't sit on the current pitch table are shown snapped to the nearest degree and painted **yellow**. The toolbox **Raw** toggle switches to 4-digit hex words.
- **Instrument** — two hex digits, `01`–`FF`.
- **Volume** — a **symbol** cell + two hex digits. The symbol says what the column *does*; the digits are its argument.
- **Pan** — the same shape, with sideways symbols (00 = left, 20 = centre, 3F = right). It pans the *note*, not the channel — see [Note volume vs channel volume, note pan vs channel pan](#note-volume-vs-channel-volume-note-pan-vs-channel-pan).
- **Effect** — a base-36 opcode letter and a 16-bit argument in four hex digits. See [Effect commands](#effect-commands).

#### The volume and panning symbols

| Symbol | Volume | Panning | Argument |
|---|---|---|---|
| *(blank)* | set the volume | set the panning | 00–3F |
| ˄ / ˅ | slide up / down, once per tick | — | 00–3F |
| ˃ / ˂ | — | slide right / left, once per tick | 00–3F |
| **+** / **−** | fine (one-shot) rise / drop | fine step right / left | **00–1F** |
| `···` | nothing — the column is empty | | |

Full volume is **3F**, i.e. 63. That is not a step short of the 64 a
ScreamTracker 3 screen shows: ST3 carries the volume in six bits too and clamps
its own `C40` down to 63, so an imported song keeps its full dynamic range —
a `C40` arrives as 3F and every quieter value arrives untouched.

In a **surround project** these two columns are wider: the volume runs 00–FF and
the panning column carries a height and a full-circle angle. See
[The wide pattern cell](#the-wide-pattern-cell).

A fine slide happens once on the row rather than every tick, so its argument is
just a magnitude (00–1F) and the **+ / −** symbol carries the direction. Setting
a fine slide's argument to zero empties the cell, since "shift by nothing" and
"no command" are the same thing.

### Navigation

| Key | Action |
|---|---|
| **← → ↑ ↓** | Move the cursor (left/right walks the sub-columns) |
| **Tab / Shift+Tab** | Next / previous channel (jumps to the note column) |
| **PageUp / PageDown** | ±16 rows |
| **Home / End** | Start / end of the song |
| **Ctrl+G** | Go to a `cue:row` (cue in hex) |
| **Ctrl+F** | Find cells by what they contain ([below](#find-ctrl-f)) |
| **wheel / Shift+wheel** | Scroll rows / channels |

### Mute and solo

In navigate mode (record **off**), **M** mutes and **N** solos the cursor
channel; pressing solo again unmutes everything. With the mouse: click a
channel header to mute, **Ctrl+click** (⌘+click) to solo. Mutes are per-song
and cleared when a file loads.

### The right-click menu

Right-clicking a channel — its header, or any row down its column — opens a
palette of icon buttons:

| Item | Action |
|---|---|
| **Copy** / **Cut** | Only with a block selected — the same as Ctrl+C / Ctrl+X |
| **Paste** | Only on a cell that has a pattern, with something on the clipboard |
| **Channel left** | Insert an empty channel *before* this one |
| **Channel right** | Insert an empty channel *after* this one |
| **New pattern** | Where the cue leaves a channel empty: point the slot at the lowest unused pattern number and put the cursor there. Over a block it fills **every** empty slot the block covers, one fresh pattern each, leaving the slots that already have one alone |

A **second row** underneath carries the Patterns-view edit tools, aimed at the
column you clicked (or, with a block selected, at the columns the block covers):

| Column | Tool |
|---|---|
| Note | **Transpose** — the same notation-aware shift as the Patterns toolbar |
| Instrument | **Instrument** — replace instrument numbers |
| Volume | **Volume** — rescale volumes |
| Panning | **Panning** — widen / narrow / shift; in a surround song a **Panner** cell sits beside it, opening the same dial as the toolbox button |
| Effect | the eight most-used effect commands: **S** Special, **D** Volume slide, **G** Tone portamento, **H** Vibrato, **E** / **F** Pitch slide down / up, **O** Sample offset, **A** Set tick rate. Picking one writes the opcode and leaves the argument alone; everything else is in the command palette at the foot of the screen. |

**Find & Change** closes that row whatever column you opened it on — it is the
general case of the tools beside it and has no column of its own. See
[Find & Change](#find-change-advanced-pattern-edit).

Each tool acts on the **selected block** — which on the Timeline may span
channels and cross several patterns — or on the single cell you clicked when
nothing is selected, in one undo step either way. The Panner reads its starting
position off the block's first cell and writes its answer to every cell in it,
which is what a `Z` slide wants anyway: it has to be re-issued on every row it
moves over. A selection covering several
columns offers one tool per column but never the effect palette: picking an
effect is a write, not a transform, and stamping one across a band that merely
happens to include the effect column is never what was meant.

The **Cues** view has the same menu — a column there is a channel too — except
that *Paste* needs no pattern under it, because a cue cell holds the pattern
*number*. The Cmd1/Cmd2 columns belong to the cue rather than to any channel, so
right-clicking them offers nothing. The **Patterns** editor has the clipboard
half only: a Taud pattern is a single channel, so there is no channel to insert
one beside. There, right-clicking focuses the column you pointed at first, which
is what lets you *Copy* in one column and *Paste* into another. Its second row
is the same as the Timeline's. The Cues grid has no second row at all — it holds
pattern numbers, not note cells.

Inserting slides the channel and everything to its right one place along. The
song's channel count is fixed at 32 or 64, so the last channel falls off the
end — you are asked first if it is carrying anything. Cue commands (pattern
length, halt, jump) stay on the channel they were written on and are never moved
by the shift. The whole insert is one **Ctrl+Z**.

### The row trough

The numbered gutter down the left addresses **song rows** rather than cells, so
it selects and edits whole rows. Drag it to select a band of rows across every
channel (**Shift+click** extends one); right-click it for the row commands:

| Item | Action |
|---|---|
| **Rows above** / **Rows below** | Insert blank rows before or after the band, asking how many first — the whole song below slides down |
| **Delete rows** | Take the selected rows out of the song; the whole song below slides up to close the gap |
| **Patterns above** / **Patterns below** | Insert an empty pattern on every channel — a blank cue as long as the one you clicked — without moving anything |
| **Row highlights** | How many rows to a beat and to a bar |

Insert and delete act on the **whole song**, every channel at once, in one
**Ctrl+Z**.

A row here is a row of the *song*, not of a pattern, and the cue boundaries stay
where they are: the music **slides through** them. Delete four rows in the middle
of the second cue and the first four rows of the third cue move up into it, the
fourth cue's move into the third, all the way down, and the song ends four rows
earlier than it did. Every cue keeps the length it had — only the last one is
shorter — so a bar line drawn by a cue boundary stays put while the notes move
past it. Insert is the same in reverse, with the rows pushed off the bottom
landing in the last cue, or in a new one when it is already full.

That is what makes these two the expensive commands. Every pattern from the edit
to the end of the song now holds a different stretch of music and has to be
rebuilt — and where a pattern is **shared**, the sharing decides what happens to
it: one that another cue still plays whole is left exactly as it was and the
edited cue gets its own copy, so a shift never moves notes in music it did not
pass through. Channels that were playing the same pattern at the same point go
on sharing one; the numbers the rebuilt cues let go of are used again rather than
left behind, so a shift costs roughly as many patterns as it frees. Cue commands
follow too — pattern lengths track the new lengths, and jumps still point at the
music they were aimed at.

Two edits avoid all of that, because they mean exactly the same thing as plain
cue surgery and are taken as such: **deleting a whole number of cues** (select
from one cue boundary to another) simply drops them from the order list, and
**inserting at a cue boundary** simply adds a blank cue. Neither touches a
pattern. **Patterns above / below** is the third of them, and the one to reach
for when what you want is a blank bar: it costs nothing, changes no pattern, and
leaves every bit of sharing alone.

**Row highlights** are the song's own **rows per beat** and **rows per bar**,
4 and 16 unless the file says otherwise. They only decide how the Timeline and
Patterns grids are banded; nothing about playback reads them. The same two
numbers are on the [Project](#project-f7) tab.

### Picking up an instrument

Turn on the **Instruments** lookup panel in the toolbox — a
floating list of every top-level instrument; click one to select it.
Scrolling on the **Inst** cell on the top bar also changes selection.

### The master strip

The panel down the right-hand edge of the Timeline is where you check the mix as
a whole: a stack of vectorscopes over a meter and a fader. It is shown by
default; the **Master** toolbox button (and the ✕ in its corner) hides the whole
strip, and while it is hidden it costs no processing at all.

It answers a different question from the [Mastering](#mastering-f6) tab. The
strip asks *where is the energy in the room?* while you write, and follows the
song's surround model; the tab asks *what is going into the file, and what did
the chain do to it?* and is about delivery. They are separate panels with
separate meters, and both are only on while you are looking at them.

**The panels.** A scope panel is a fixed size — its chooser, a square dial and a
correlation bar — so how many of them you get is a question about your screen:
two by default, more on a tall window, fewer on a short one. There is no
arbitrary limit; the ceiling is simply one panel per view the song has — all six
on a spatial song, two on a stereo or planar one, since a third could only
repeat what the panel beside it is already showing. Each panel's
chooser picks what it shows, and its last entry, *Hide this panel*, drops **that
panel** (the strip stays). **+** in the header adds one back whenever there is
room, and hands it a view none of the others is using. A panel set to a view the
current song cannot express — a height view on a song that is not spatial —
simply waits: it is not drawn, it does not turn into a second copy of another
panel, and it comes back as itself the moment you open a song that has that
axis.

The **divider** above the meter is the same control by another name: a scope
panel is a fixed size, so where the divider sits and how many panels are above
it are one and the same thing. Drag it down and panels close as it passes them;
drag it back up and they open again, taking the next view the song has. The
meter always takes exactly what is left. Double-click the divider to go back to
two panels. Everything here is remembered between sessions — and if you open the
app in a window too short for the panels you had, the ones that no longer fit
are closed rather than left half-drawn, so what you see is always what the strip
thinks it has.

**The vectorscopes** come in four families, and all of them draw the same three
views of the same space, on the same axes — **top** (left–right against
front–back), **front** (left–right against height) and **side** (front–back
against height). Each labels its own edges, so there is never a question of
which way round it is, and any two panels showing the same view line up.

*Blobs* shows the **sources**: a dot for every sounding channel, drawn where the
engine actually has it — the same reading as the Panner and the channel radars.
*Blobs (top)* is the tracker's own view and the one you will use most; *front*
and *side* are there when you want to see the height of a mix at a glance. On
the top view a dot carries the height cue (it grows as it rises and casts a
shadow) because a dial seen from above cannot otherwise tell up from down; on
the other two, height is the vertical axis and needs no cue.

*Goniometer* traces the **sound** itself rather than the channels. A stereo song
has no front–back axis and a planar song has no height, so every view that would
be a flat line is simply not offered — which leaves a stereo song with the two
top views.

A Goniometer view is drawn the way the hardware instrument of the same name drew it: as a
**beam**, dragged from where one sample was to where the next one is, leaving
light behind it. So the trace is a connected figure rather than a scatter of
dots, and three things about a real screen come with it.

*Brightness is dwell.* The beam lays down the same charge every sample, however
far it travels, so where it lingers the light piles up and where it races across
the dial it thins out — the turning points of a figure burn while the sweep
between them stays faint. A beam asked to slew hard dims a little further still.
What that adds up to is a display where the **bright part is where the sound
actually is**, not merely where it reached.

*Light adds up.* Twenty passes over the same spot really are twenty times the
energy of one. Ink runs out long before that, so a spot far past saturation
starts going white instead (dark, on the light theme) — density keeps reading
after opacity has nothing left to say.

*The screen fades rather than being wiped.* Each frame adds the samples that
arrived since the last one and lets the rest decay, over about a tenth of a
second. The figure therefore settles into something you can look at instead of
flickering, it looks the same whatever frame rate your machine manages, and when
the music stops the trace dies away rather than freezing on its last window.

In a stereo song the top view is the familiar mid/side goniometer: a vertical
trace is a mono-safe mix, a horizontal one is very wide, a diagonal one leans to
that side. This is not a special case — for two speakers, left–right and
front–back *are* side and mid — so the same display serves every song. It is
auto-gained so a quiet mix still fills the dial, with the factor shown in the
corner; the meters below it are the absolute reading. A mix that is already at
the clipping point is never magnified — the gain reads ×1 and the figure keeps
some room inside the rim. The gain glides over about
a third of a second rather than snapping, so a transient briefly overruns the
dial instead of yanking the whole figure smaller — the shape has to hold still
enough to compare from one moment to the next.

*Radiation* is the third family, and the only one that draws the field as a
**solid object**. For every direction around you it works out what the encoded
soundfield actually radiates that way, and pushes the surface of a sphere out by
that much: a mix with no direction to it is a sphere, one leaning forward grows a
lobe out of the front, a null in some direction is a dent. The three views are
the same object seen from three places — switching a panel from *top* to *front*
moves the camera and nothing else — so a lobe you see leaning left in one is the
same lobe leaning up in another.

What makes it worth having next to the goniometer is that it is built from the
field **before** the levels are taken, so what you are looking at is
interference and not a set of independent readings. Two identical sources sixty
degrees apart do not draw two lobes; they draw one, between them, because that
is what the sound does — the phantom centre you would hear. Flip the phase of
one of them and that centre becomes a **null**, and the same two sources fly
apart into two lobes with a hole between them. Two sources on opposite sides of
you collapse into a featureless sphere in phase, and into a figure of eight with
a dead plane through the middle out of phase. None of that is drawn as a special
case; it is the shape the arithmetic produces.

**Colour is spectrum, never level.** The field is analysed in five bands, and
each direction is tinted by the mixture it is carrying: bass through to air
runs salmon, yellow, green, cyan, violet — the same ramp as the effect columns —
and the five swatches in the corner of the dial are the key. A direction with
one band in it takes that band's colour; a broadband one comes out near-neutral.
A quiet cymbal and a loud one are the same colour and different sizes, which is
the only way round that makes a colour scale mean anything. Hover the panel for
the exact frequencies.

The analysis behind both the shape and the colour is **tilted by 4.5 dB per
octave**, lows down and highs up. Music is not a flat spectrum — it falls away
with frequency at roughly that rate — so an untilted analyser would hand almost
the whole surface to the bass and every song would be a salmon ball. With the
tilt, a normally balanced mix reads as a balanced surface, and what you see is
this mix rather than the shape of music in general. A song that really is
bass-heavy still shows it; it just has to be bass-heavy for its own material
rather than merely for being music. The tilt is on the analysis only: the fade
that takes the surface away when the music stops reads the field's true level,
so a loud bass passage never fades out for being low.

The surface is **auto-sized** like the goniometer, so its shape is readable at
any level and the meters below remain the absolute reading. It shades and shrugs
off jitter over about a fifth of a second, with a slower hand on the colour so
the hue does not strobe, and when the music stops it fades out rather than
freezing on its last window. A **latitude/longitude grid** rides on the surface —
that is what lets you see how far the sphere has been pushed out or pulled in —
and the far side of the shell shows faintly through the near one, so a lobe
pointing away from you is behind rather than gone.

A stereo song keeps the top view of this one too, and it is worth a look: with
no front–back and no height the surface becomes a figure of revolution about
the left–right axis, which is a sphere for a mono mix, a cardioid leaning to
one side for a hard pan, and a figure of eight with a null straight through the
middle for anything out of phase.

*Cloud* is the fourth family, and the one that draws the **spatial image**
rather than the field. It splits the sound into frequencies and asks, of each
one, where it is arriving from — then draws it as a splat there. Because a mix's
parts mostly occupy different frequencies, the cloud separates things the
radiation surface blurs together: two instruments panned wide are one broad lobe
on the surface and two distinct clusters here.

**How far out from the centre a splat sits is how far outside your head that
part of the image is**, and the rule is simply the cosine of the angle the
sources sit at. A single source is on the rim, fully localised and outside you.
A pair at ±30° — an ordinary stereo setup — images at cos 30°, most of the way
out; at ±60° it is exactly half way in; and a pair placed equidistant either
side of you, ±90°, collapses to the dead centre, because that is where such a
pair is heard: inside the head, with no direction at all. Reverb and anything
else without a direction arrives at the middle by the same route, with nothing
special written to put it there.

**Out-of-phase material is not treated as a phantom.** Invert one side of a
stereo pair and you no longer hear a centre image at all — you hear two separate
sources, wide apart — so the display must not drop it in the middle beside the
in-phase case. It does not: when two sources cancel in pressure they are still
moving the air, and that leftover motion is drawn as **a pair of splats on the
rim, at the two bearings the sources are actually at**. So an in-phase pair
collapses inward as it widens, while an out-of-phase one stays out at the edge
in two places — which is what you hear.

**Size and opacity are both the level.** A splat's size is its level in
decibels, and its opacity follows the same decibels over the same range, so the
loud parts of the image are big and solid and the quiet ones small and faint.
The two never disagree, which keeps a busy cloud readable. The scale they are
measured against drifts with the music rather than being reset every instant —
it rises quickly enough that a transient cannot wash the picture out, and falls
slowly, so the gaps between notes do not pump the brightness back up.

**What points away from you recedes.** The three views are flat projections, so
a direction behind the camera would otherwise land on top of one in front of it
and look identical. Instead the far side is drawn dimmer and slightly out of
focus, the way distance works on the eye — the hue stays the band's own and the
distance from the centre still means what it meant, so nothing is spent to buy
the depth.

The cloud **accumulates**: each analysis is laid over what is already there and
the whole thing fades, so a moving image draws a trail and what you see is the
last fraction of a second rather than one window of it. A still, sustained chord
settles into a sharp shape; a busy passage boils. When the music stops it fades
out.

Under each scope is the **correlation meter**, a thin bar growing out of the
centre: nothing at all when the mix folds to mono cleanly, wider as the two
sides disagree, full width when they are in anti-phase. It is measured over
about half a second of audio and then eased, because correlation is a statistic
and a fraction of a second is not enough of one — the bar moves at the speed of
the music rather than twitching at every transient.

**The meter** shows RMS and peak in one bar — the fill is the RMS, the line
across it is the peak, held for a moment before it falls — with a clip light on
top of each bar. The clip light **latches**: once a channel has clipped it stays
lit, however long ago it happened and however quiet the song has gone since, and
only starting playback again puts it out. You can leave the room and still know
whether that take clipped. Peak is a **true peak**: the level
between the samples, which is what a resampler or a decoder runs into even when
every sample is inside.

The fill is a **true RMS** — the root mean square of the samples themselves,
with no reference waveform assumed — so a sine reads 3 dB under its peak and a
square reads level with it. The peak line, being an inter-sample reading, is the
one that moves: a square wave has no signal between its samples that a
reconstruction filter can follow without overshooting, so its line sits a decibel
or two above its own fill, and further still at pitches where the sample rate
conversion puts the edges between output samples. That gap is the waveform's,
not the meter's. A filtered square is a different matter: close the instrument's
filter far enough and what reaches the bus is a sine, gap and all.

**What it measures is up to you** — the chooser at the foot of the meter panel —
and it need not be what you are listening to. A
surround song can be metered as stereo, as quadraphonic, 5.1 or 7.1 — those are
the same speaker feeds [Export audio…](#import-and-export) writes, so the bars
match the file you get — or as the **ambisonic** field. A speaker layout's bars
stand where its speakers do, left to right around you: `Ls L C R Rs` for 5.1,
`Lrs Lss L C R Rss Rrs` for 7.1. There is no LFE bar, because the exporter leaves
that channel silent by design and a permanently empty meter tells you nothing. There are no speakers in an ambisonic
master, so that setting meters the field itself: one bar for the acoustic energy
in the encoded sound field, which reads the same whichever direction the sound
arrives from, next to one bar per encoded channel so you can see which of them
is close to clipping. A planar song meters the three channels it can excite.

**The fader is the song's global volume**, not a monitor knob. While the song
plays it follows the `V` and `W` commands as they move it, so a written fade is
visible as it happens; dragging it writes the project's own value as a single
undo step, and stopping playback snaps it back to that value. Double-click
resets it to the default, and the mouse wheel nudges it.

## Editing

### Record mode

**Insert** (or the **⏺ rec** button) toggles record mode — the cursor caret
turns amber. With record **off** the piano keys only audition ("jam") notes;
with record **on** they write into the pattern and step down one row.

Auditions play on their own voices, apart from the song's channels. That means
they are heard even when the channel you are working on is **muted** or soloed
away, they never cut a note the song is playing, and holding several keys at
once sounds a **chord** — up to sixteen notes. With record **on** the keyboard
goes back to one note at a time, because there each key writes a cell.

### Entering notes

The note column uses two physical piano rows (layout-independent — they follow
key position, not labels):

```
 micro:  Q         R             I
 black:     W   E     T   Y   U     O   P
 white:   A   S   D F   G   H   J K   L   ;
  note:   C   D   E F   G   A   B C   D   E
```

The white row runs from **A** = C of the jam octave to **;** = E of the one
above, with the black keys where a piano puts them. **Q**, **R** and **I** sit
where a piano has *no* black key — the two places a scale step is only a
semitone wide — and play the **half-sharp** (demisharp) of the white key to
their left: B half-sharp of the octave below, E half-sharp, and B half-sharp.
They are quarter-tone keys, so in a 12-TET song they enter a note that lands
between two piano keys and the cell shows it with a cents marker.

**[** and **]** shift the octave. Entering a note also stamps the current
instrument into the cell (unless the cell already has one).

Entry is **notation-aware**: in a non-12-TET song, the keyboard's positions map
to the nearest degrees of the song's pitch table, so you play that tuning's
scale rather than fixed 12-EDO — and in a table that has quarter-tones (24-TET,
31-TET, 41-TET…) the three half-sharp keys land on real degrees. To reach every
degree of a larger table, enter a nearby note and step it with the mouse wheel
(one wheel click = one table degree).

### Note sentinels

| Keys | Word | Symbol | Meaning |
|---|---|---|---|
| **z** or **`** | `0001` | `===` | Key-off — release the note (envelopes enter their release phase) |
| **x** | `0002` | `^^^` | Note cut — stop immediately |
| **c** | `0003` | `~~~` | Note fade — fade out at the instrument's fade rate |
| **v** | `0004` | `~^~` | Fast fade |
| **Delete**, **Backspace** or **.** | — | | Clear the note (and instrument) |

**Delete**, **Backspace** and **.** are interchangeable everywhere on the
pattern grids: whichever one you reach for erases the column under the caret.

### Instrument, volume and pan columns

Type **hex digits** to set values nibble by nibble.

The volume and panning columns are three positions wide — the **symbol** cell
and the two argument digits — and the left/right arrows walk through all three.
On the symbol cell one keypress chooses what the column does:

| Key | Volume | Panning |
|---|---|---|
| **^** or **u** | slide up | — |
| **v** or **d** | slide down | — |
| **>** or **r** | — | slide right |
| **<** or **l** | — | slide left |
| **+** or **=** | fine slide up | fine step right |
| **-** | fine slide down | fine step left |
| **.**, **Delete** or **Backspace** | plain set | plain set |

Any argument already in the cell is kept and re-read under the operation you
picked, and the caret hops onto the first digit so you can retype it straight
away. Picking a fine slide over a blank argument starts at 1 (a fine slide of
zero would be no command at all). Typing hex on the symbol cell skips ahead to
the digits, so you can also just type a value and leave the symbol alone.

On the two digit positions, **Delete** / **Backspace** / **.** write the no-op
sentinel so the cell goes blank. The command palette carries a button for every
operation.

### Note volume vs channel volume, note pan vs channel pan

Volume and panning each come in **two independent kinds**, and knowing which one
you are writing saves a lot of head-scratching:

| | The **note** kind | The **channel** kind |
|---|---|---|
| Volume | the **volume column** | **M** (set) and **N** (slide) |
| Panning | the **panning column** | **S $80xx** (set), **P** (slide), and **X** / **4** / **Z** in a surround song |
| Who else writes it | the instrument — its default volume and pan, and an Ixmp zone's | nothing but the commands above |
| Reset by a new note? | yes, when the note's instrument has a default of its own | no, ever |
| How they combine | volume multiplies, panning adds | |

The short version: **the mini-lanes are about the note, the effect column is
about the channel.** A note volume is how hard *this note* was struck; the
channel volume is how loud that part sits in the mix, and it stays put however
many notes go by. `M $2000` after a quiet note leaves the note quiet — it has not
turned anything up, it has set the fader for the channel.

Panning works the same way, and this is what makes zone-panned instruments
behave. If an instrument pans by pitch — a piano laid out across the stereo
image, a drum kit with the toms spread out, most things imported from a
SoundFont — that spread lives on the **note** side. So:

- **S $80xx** *rotates* the whole spread. `S $8040` swings that piano to the left as one instrument; the low keys stay left of the high keys.
- The **panning column** places one note outright, ignoring where its zone would have put it. Use it when you want *this* note somewhere specific.

Both can appear on the same row and both apply — they are not fighting over one
setting. If you want the older "everything to one spot" behaviour, put the
channel where you want it and write the panning column on each note.

**A Layered metainstrument works the same way, one level down.** If its layers sit at
different places — an SF2 preset whose sub-instruments spread out, a kit built
by hand — that spread is the instrument's, and panning the note moves the whole
thing while the layers keep their distances from each other. The layer at the
top of the Layers tab is the one the pan command lands on; the rest arrange
themselves around it, exactly as detune is measured from that same layer. A
layer with no panning of its own just goes wherever the metainstrument goes.
An **FM Rack** is the simple case instead: however many operators it holds it is
one signal in one place, so it goes exactly where the note is put.

### The effect column

The first character is the opcode — any base-36 key (**1–9, A–Z**); the caret
then moves into the four-digit hex argument. The command palette lists every
opcode with a tooltip, and while on the argument column it documents the
argument format of the current opcode. **Delete** clears the effect.

The argument is coloured by what it *means*. Almost no command reads its four
digits as one number — `H` is a speed and a depth, `D` is a slide nibble over a
reserved byte — so each of a command's argument fields takes its own shade of
amber, running lighter left to right. Two extras fall out of that: the
sub-command digit of a multiplexed command keeps the opcode's own darker ink, so
`S8` and `SD` read as the two-character commands they are; and digits the engine
*reserves* go dim, which is how you can tell at a glance that the `00` at the end
of `D 4000` is not a value you can use.

### Mouse-wheel editing

In record mode, the wheel over any cell steps the hovered column in place:
notes by one degree of the pitch table, everything else by one. On a fine
slide the wheel walks the signed delta (…−2, −1, +1, +2…) and stops either
side of zero, since the direction is the symbol cell's business. Hovering the
top-bar **Oct** / **Inst** / **Spd** displays and wheeling changes the jam
octave, steps through the used instrument slots, or nudges the live playback
speed.

### Undo and redo

Everything is undoable: **Ctrl+Z** undoes, **Ctrl+Y** (or **Ctrl+Shift+Z**)
redoes. Bulk operations (retune, transpose, imports, pattern tools, sample
DSP) are single undo steps. The counter next to the buttons shows the stack
depth.

## Block selection and clipboard

Timeline and Patterns support rectangular selections:

- **Drag** with the mouse to select rows × channels. A drag also records which *columns* (note / instrument / volume / pan / effect) it covers, so a narrow drag lets you copy just volumes, or just notes. Any drag counts, including one that stays inside a single row or a single column — "just the panning of this row" is a selection you can copy.
- **Shift+arrows** (and **Shift+PageUp/Down/Home/End**) extend a whole-cell selection from the cursor.
- **Ctrl+C / Ctrl+X / Ctrl+V** copy, cut and paste. A paste lands on the **start of the selection** when there is one — the corner you began the drag from, not the cursor, which sits wherever the drag ended — and on the cursor when there is not. Pasting across views clips to what fits; a column-limited block overwrites only its columns.
- **Right-click** for the same three as buttons: *Copy* and *Cut* while a block is selected, *Paste* on any cell that can take one. See [the right-click menu](#the-right-click-menu); the Cues view carries the same clipboard cells over its cue words.
- **Delete / Backspace** blanks the selection, **Esc** clears it.
- **The clipboard is shared between browser tabs.** Copy in one tab of Microtone and paste in another, so two songs open side by side can pass material between them; the copy outlives the tab that made it. The cue clipboard travels the same way.

## Cues (F2)

The Cues view is the song's order list: one row per cue, one column per
channel, each cell holding the pattern number (hex) that channel plays during
that cue.

- Type **hex digits** to enter a pattern number (`0000`–`7FFE`).
- **Delete** / **.** empties the slot.
- **Space** opens the command popup for the cell. Commands occupy the slot instead of a pattern:

| Command | Meaning |
|---|---|
| **LEN** | Set this cue's pattern length (1–64 rows) |
| **HALT** | Stop playback after this cue |
| **HALT@** | Stop after N rows into this cue |
| **BAK** | Go back N cues |
| **FWD** | Skip forward N cues |
| **JMP** | Jump to cue N |

The grid **scrolls the whole cue address space** (up to 8192 cues, 4096 in
64-channel mode), like a spreadsheet — you can move to any row even if it is
empty. This is how you extend the song past a **HALT**, or grow a brand-new
project beyond its single cue 0.

The file **saves only up to the last used cue**: trailing empty cues are trimmed
away, so scrolling far down (or deleting the tail of a long song) never bloats
the save. The one caveat: *interior* gaps are kept — if you put content on cue 0
and cue 2000 with nothing between, all 2001 cues are stored (gzip keeps that
cheap).

**Block copy/paste.** Select a rectangle of channel cells by dragging with the
mouse, or with **Shift+arrows**; then **Ctrl+C** / **Ctrl+X** / **Ctrl+V** copy,
cut and paste, **Delete**/**Backspace** blank the block, and **Esc** clears the
selection. Paste lands with its top-left corner at the cursor, so you can move a
group of voices onto different channels, onto other cues, or onto the blank row
to grow the order list. Only the pattern numbers move — each destination cell
keeps its own flow command. (The Cues clipboard is separate from the
Timeline/Patterns cell clipboard.)

## Patterns (F3)

A focused editor for a small set of patterns, with the same cell editing as the Timeline.
The header shows which cues (and channels) use the pattern — remember that
editing a shared pattern changes every place it plays.

- **▶ Preview** plays just this pattern in a loop-free scratch cue.
- **Duplicate** copies the pattern into a fresh slot.
- **Transpose…** shifts every note, notation-aware: the fine unit is semitones / steps / note units depending on the preset, the coarse unit octaves (or periods for non-octave tunings). Percussion instruments and sentinels are skipped.
- **Lengthen… / Shorten…** stretch or squeeze the rows by given amount (Impulse Tracker's Alt-F/Alt-G maps).
- **Volume…** rescales set volumes (`new = old × multiply + add`).
- **Pan…** widens/narrows around centre and shifts (`new = 20 + (old − 20) × widen + shift`); a negative widen mirrors left/right.
- **Instrument…** replaces instrument numbers (leave *From* blank to replace all).
- **Find & Change…** is the general case of the four above it: pick cells by what they contain, then change any column of the ones that match. It has [its own section](#find-change-advanced-pattern-edit) below.

The volume/pan/instrument tools honour an active row selection; otherwise they
act on the whole pattern.

On a **version-3 (surround) project** these tools work in that format's own
units: volume runs 00–FF rather than 00–3F, so *add* reaches ±255; and the
panning column is a whole angle, so *shift* reaches a full turn, the centre it
widens about is **front**, and a move past hard left carries on round behind you
instead of stopping there — on a circle, hard left is a direction, not an edge.

### Find (Ctrl+F)

**Ctrl+F** opens a find bar under the grid. Pick a column, pick a test, type a
value, and **Enter** takes the cursor to the next cell that matches;
**Shift+Enter** to the previous one. Both wrap round the end, the count beside
the box says *3 of 17*, and **Esc** puts the bar away and hands the keys back to
the grid.

What it searches is whichever grid you opened it from, in that grid's own terms:

- from the **Timeline**, the song in **play order** — every cue, every row, every channel that has a pattern — so a match is a place the cursor simply goes. One pattern placed in six cues is found in all six.
- from **Patterns**, the **pattern bank** in ascending order, and the pane follows the match to whichever pattern it is in. This is the only way to reach a pattern no cue has placed yet.

The value is read in the column's own base — **hex**, like everywhere else —
with `#` for decimal, and the note column also takes names (`C-4`). The bar
reads back what it parsed (`$5000 C-4`) beside the box, so the base is never
something to remember.

One test covers nearly every search worth making. For more than one —
conditions ANDed, alternatives ORed, ranges, *every fourth row* — the
**Criteria…** button opens the full editor described below, without its Change
half; the bar then reports what it is holding rather than showing you half of
it. The criteria are shared with Find & Change, so *find these* and then
*change the ones I just found* is one thought and not two typings.

### Find & Change (advanced pattern edit)

Every tool above answers one fixed question — *scale these volumes*, *replace
this instrument*. **Find & Change** lets you ask your own: it takes a
**predicate** that picks cells out by what they contain, and a list of
**changes** to make to the ones it picks. *Halve the volume of every note
quieter than $20*, *put a `H` vibrato on every fourth row*, *clear the second
effect wherever the first one is a `G`* — none of which any of the fixed tools
can express.

It opens from two places, and is the same dialog either way:

- the **Find & Change…** button on the Patterns toolbar, which acts on the selected rows (or the whole pattern with nothing selected), and offers **all patterns in this song** beside that;
- the last cell of the right-click menu's tool row in the **Timeline** and **Patterns** grids, which acts on the selected block — on the Timeline that may cross channels and patterns — or on the single cell you clicked. (The Cues grid holds pattern numbers rather than note cells, so it has no tool row at all.)

**Conditions and terms.** A *term* is one test on one column. The terms inside a
*condition* must **all** hold; **any one** condition matching is enough. So
`+ and…` narrows a condition, `+ or…` adds an alternative beside it. With no
conditions at all, every cell in range is a match, which is how you say "all of
them".

Each condition carries its **own event count** in its bottom-right corner — the
events (rows × channels) *that* condition selects on its own, whatever the
others do. It is how you see which alternative of an *or* is doing the work, and
which one is quietly selecting half the song. A cell that two conditions both
match is counted on both, so the per-condition numbers can add up to more than
the total underneath: they answer "what does this one match", not "what did this
one add". A condition you have not finished typing shows no count at all rather
than a zero.

The columns you can test:

| Column | Notes |
|---|---|
| **Note** | the note word; type a name (`C-4`, `F#3`) or the word itself |
| **Instrument** | 00–FF |
| **Volume** / **Panning** | the column's value |
| **Volume column** / **Panning column** | what the column *does* — set, slide, fine slide, or blank |
| **Elevation** | version-3 projects only, signed −128…127 |
| **Effect** / **Effect argument** | picked from the named opcode list; the argument is four hex digits |
| **2nd effect** / **2nd effect argument** | version-3 projects only |
| **Row number** | 0–63 within the pattern — a test only, never written |
| **Whole cell** | *carries something* / *is blank* — a test only |

A project is never offered a column its format has not got: a version-2 song has
no elevation and no second effect, so they are not in the list.

The operators are the ordinary comparisons (`is`, `is not`, `is below`, `is at
most`, `is above`, `is at least`), `is within` / `is outside` a pair of bounds,
`modulo` (`row number modulo 4 = 0` is every fourth row), and the two that need
no value at all: **carries something** and **is blank**. An opcode or a column
operation can only be matched, not ordered — there is no "effect above `G`".

**The changes.** Each one is a column, an operation and its values:

| Operation | Effect |
|---|---|
| **set to** | write the value |
| **add** | value + this (negative to subtract) |
| **multiply by … +** | value × this + that — the general case, and how a proportional change is made |
| **clear** | blank the column |

They run **in the order listed**, each seeing the one before it, so *× 2* then
*+ 1* is a two-line answer as well as a one-line one.

Three rules keep a bulk edit from doing damage on your behalf:

- **Arithmetic only moves what is already there.** *Add* and *multiply* skip a column that carries nothing, so a `+1` over a whole pattern will not stamp instrument 01 into every empty cell. *Set* writes regardless — that is what makes it *set*.
- **Setting a value into a blank volume or panning column makes it a plain *set***, not the fine slide the blank column's encoding would otherwise turn it into. Same rule as typing a digit into an empty column by hand.
- **Notes keep out of the sentinel space.** Arithmetic skips key-offs, cuts, fades and interrupts, and a downward transpose stops at the lowest playable note rather than falling into them. *Set* can still write a sentinel, which is how a key-off is stamped across a block.

Two smaller ones: changing what a column *does* leaves a blank column blank (the
operation describes what to do with a value it has not got), and clearing an
effect clears its argument with it. On a version-3 cell, clearing the panning
column clears the elevation too — they are one column on screen and one
statement to the engine.

**Typing values.** Columns are read in the base the grid shows them in, which is
**hex** — `30` in the volume column is $30. Prefix with `#` for decimal (`#48`),
or with `$` / `0x` if you like typing it. The note column also takes note names,
the effect columns their opcode from a list. Every row reads back what it
actually parsed — `$30 (48)`, `$5000 C-4` — so a column's base is never
something you have to hold in your head.

**Before you commit.** The line under the form counts what the query really
selects, live, as you type: *17 of 512 cells match · 12 will change*. The two
numbers differ when a change would leave some matches as they were. **Apply**
stays greyed out until something really would change, and the whole edit is one
**Ctrl+Z** however many patterns it crossed. The query is kept for as long as
the tab is open, so running it again with one field changed does not mean
retyping the other six.

## Samples (F4)

Lists every distinct sample in the pool (from base instruments and Ixmp
patches alike) with its name, length and rate. The waveform display shades
loop regions and shows live play-position cursors while audio runs. Piano keys
audition the selected sample's instrument.

Move the pointer over the waveform and a hairline follows it, captioned with
the **byte offset** under the line, that offset in hex, and the byte's own
value. Bytes are the unit everything else about a sample is spelled in — loop
points, `O` sample offsets, the ranges the sample-modification effects work
over — so this is how you read a number off the picture instead of estimating
it.

If a voice using the sample is running the invert loop (`S $F0xx`) or one of
the sample-modification effects (`2` and `3`), the waveform display shows the
result live: bytes the invert mask has flipped are XORed, bytes a rotation has
moved are drawn where they are being read from, a level slide is drawn at the
level it is playing, and everything the modification touches is drawn in the
invert colour. You see the waveform actually being played back, not the
sample's original bytes.

Funk repeat (`Z $Ffxx`) leaves the bytes alone and moves the loop instead, so
what you see there is the play cursor: it jumps clean out of the loop shading
and works through the waveform a hop at a time, which is exactly where the note
has got to. The `$f` nibble picks that hop — a whole loop length, a half, a
quarter or an eighth of one, going forwards, going backwards, going forwards
with each landing jittered, or thrown anywhere in the sample — and the band
drawn over the waveform, with the next hop outlined beside it, follows whichever
you chose. It needs room to do that — a loop sitting at the very end of its sample
has nowhere to hop and the effect stays silent.

**Edit…** opens the selected sample in the [Sample Lab](#the-sample-lab) — the
one sample editor. Crop, EQ, chop, normalise, fade, chord: everything the Lab
does, it does here too, on a high-resolution float copy of the pooled bytes.
What differs is how you leave it, and the Lab offers both ways:

- **Replace** writes the edit back over the pooled sample. Every instrument using it plays the new audio — that is the point, and it is why the button asks first, listing the instruments it will reach. The length may change: the sample is re-placed in the pool, every instrument and patch bound to it follows, and each one's play and loop points are carried through the edits you made (a crop shifts them, a cut closes over them, a resample scales them). One undo step puts all of it back.
- **Import as new** lands the result as new samples and instruments and leaves the pooled original untouched — the right choice when you are deriving a variation rather than fixing the source.

Replace is offered only when the Lab was opened on a pooled sample, and only
for a single sample: chop the take into several chunks and only *Import as
new* remains. Two edits it will not do in place, because the format cannot
express them safely: turning a **mono** sample into a **stereo** one (import it
as new instead), and changing the length of a sample whose pool bytes overlap
another sample's.

**Rename** the sample by typing in the Lab's **Name** field before you Replace.

**Chord…** is the same trip with the [chord maker](#the-chord-maker) already
open: mix pitch-shifted copies of the sample into one chorded waveform.

### Stereo samples

A sample can be **stereo**: two channels that play as one voice. The list marks
those rows `ST`, the info line says *stereo*, and the waveform shows the two
channels stacked (L above R). A stereo sample is still ONE sample — one name,
one row, one set of loop points and one rate — it simply occupies two spans of
the sample pool, so it costs twice the bytes.

Only an instrument *patch* can carry a second channel, so an instrument that
plays a stereo sample always has at least one Ixmp patch (see
[Advanced Edit](#advanced-edit-ixmp-patches)); the instrument's own record
points at the left channel, which is what a mono player would fall back to.

Panning treats a stereo sample as a mixer balance: at centre you hear both
channels in their own speakers, and panning fully left silences the right
channel. A stereo sample whose channels are identical sounds exactly like the
mono sample it came from.

Editing follows the pair. **Edit…** opens both channels as one stereo take in
the Lab and applies each tool to both in one undo step (Normalise shares one
factor across them, so the stereo image is not re-balanced); **→ Mono** there,
followed by Replace, folds the pooled sample down to one channel and hands the
right channel's bytes back to the pool. **Paint…** opens one lane per channel:
a stroke edits the lane it starts in, so you can draw the channels apart — the
shape buttons (Sine, Saw, …) fill both lanes, since a seed is a whole-waveform
shape.

Stereo samples reach a project from a stereo audio file or recording (through
the Sample Lab), from an `.it` module whose samples are stereo, or from a
SoundFont import with **Import stereo instruments in stereo** ticked.

### Sample memory

The list is a census of *samples*, not a map of *memory*. It shows one row per
distinct claim — a pointer into the 8 MB sample pool and a length — which is the
right unit for naming, editing and exporting, and it deliberately says nothing
about where those bytes are or who else is reading them. **Memory** in the
toolbar opens a panel that shows the pool itself. It stays open until you turn
it off, and it never changes anything: it only reports.

Three strips, top to bottom:

- **The whole pool** — all 8 MB at once, with megabyte gridlines, so how much room is left needs no arithmetic. A tick marks the selected sample, and a rule marks the high-water mark (the end of the last claimed byte).
- **The claimed range** — 0 up to the high-water mark, one block per pool span. This is the map proper. Samples that overlap each other are drawn on separate lines, so a second line anywhere means two rows really are reading the same bytes.
- **Around the selected sample** — a few sample-lengths of neighbourhood, where names fit and each block carries a thin bar showing the loop region that row declares. This is where "these two rows are one recording" becomes obvious.

Hovering reads out an address range, the sample it belongs to and how many
instruments play it; clicking any block selects that row in the list, so the map
navigates. While the song plays, a tick per sounding voice shows where in memory
each note has got to.

Colours: **claimed** is one sample's bytes, **shared** means more than one row
claims them, **selected** is the row the list is on, **free** is unclaimed, and
**leftover** is unclaimed space that still holds the audio of something deleted.

Underneath, the panel names what it found — and these are the things worth
knowing about, because none of them are visible from the list:

- **Overlapping samples.** Two rows can be different windows onto one recording: the same bytes with different lengths, loop points or rates. Editing either one rewrites the other, which is why the Sample Lab refuses to *change the length* of a sample whose bytes another sample overlaps. A stereo sample's own two channels are not an overlap — it is one sample occupying two spans.
- **Samples pointing outside the pool.** Almost every module conversion leaves a few junk instrument records behind, usually up at the top of the slot range, whose sample pointers land far outside 8 MB. They appear in the list looking like ordinary samples and they play nothing. [Housekeeping](#housekeeping) drops them.
- **Gaps.** Deleting a sample, or replacing one with something that no longer fits its old span, leaves a hole. A new sample is fitted into the first hole big enough for it, so holes are reused rather than wasted — but a pool full of small holes can refuse a large sample while showing plenty free, and the panel gives you the largest run so you can see that coming. **Defragment sample memory** in [Housekeeping](#housekeeping) closes them all up into one run at the top.
- **Leftover audio.** Freeing bytes does not always blank them, and bytes nothing points at still travel inside the project file. Housekeeping sweeps them.

### The map: the pool as one long waveform

**Map** in the toolbar swaps the one-line waveform for the pool drawn as a
waveform *wrapped across as many lines as it takes*, with the byte address of
each line down the left — a hex dump, with audio where the digits would be.
The sample-memory panel above answers *where are these bytes?*; the map answers
*what do they sound like, and what else is in there?*

- Each line is a fixed number of pool bytes. **−** and **+** change how many (Ctrl+wheel over the map does the same, keeping the byte under the pointer still); **Fit** picks a zoom that shows the whole thing at a readable length. The map fills the pane, so a taller window is more lines rather than empty space.
- Under each line runs a strip of **blocks**, one per sample, each with its number and name inside it and each starting a rule that runs up through the waveform where its audio begins. Blocks are **coloured by row number** through a five-colour cycle, so no two touching blocks ever share a colour and a sample keeps the same colour everywhere it appears — including across the several lines a long one spans. A **recording** loaded into memory is the band behind them, so the samples cut out of one are drawn inside it. The row the list is on wears the selection colour instead. Clicking a block selects that row in the list.
- The hairline follows the pointer and reads out the pool address, the byte's value, and which recording and sample the byte falls inside.
- While the song plays, a tick per sounding voice runs through the lines.

**Drag across the waveform to select a window of bytes.** *Cut instrument…*
then makes an instrument that plays exactly those bytes — see below.

**Hear it before you cut it.** ▶ auditions the selected window, or the sample
the list is on when nothing is selected; ↻ beside it repeats until stopped,
which is how a loop point gets judged. **Double-click anywhere on the map** to
hear a few seconds from that byte — the way to walk a long recording without
selecting anything first. A window inside a stereo recording is auditioned as
the pair it would be cut as, and everything plays at the rate the cut would
give it, so what you hear is what the instrument will play. The audition is
ordinary playback rather than the tracker engine: it works whether or not the
song is playing, adds no instrument and no voice, and stops when you leave the
view.

**Every project already has a recording to look at: the memory it is using.**
*All sample memory* is listed at the top of the Samples list in every project,
including every project made before any of this existed. Select it and the map
opens on everything the pool holds — every sample the song uses, end to end, in
the order they sit in memory. Nothing declares it, so there is nothing to
rename or delete; it is a view of what the rows below it already are. Cutting a
window out of it works exactly as it does out of a loaded recording, and the new
instrument takes the rate of whichever sample the window starts inside — so
lifting a syllable out of a vocal sample, or one hit out of a drum loop that
arrived with a module, needs nothing loaded first.

### Long recordings in memory

The ordinary way to fill a project is one sample per instrument: import a file,
it becomes an instrument. There is another way, and it is what the map is for.

An instrument's sample length is a **16-bit** field: 65535 bytes, about two
seconds at 32 kHz, is the most any single instrument can play. The pool is 8 MB.
So instead of importing sounds one at a time, you can load a handful of very
long recordings straight into memory — a whole breakbeat, a take of a solo, a
field recording — and cut every instrument you need out of them afterwards.

**Load recording…**, above the sample list, does the loading. It asks for a
rate (a lower one costs proportionally fewer pool bytes and is the pitch the
windows will play at), offers to fold a stereo file to mono, and tells you what
the recording will cost against the largest free run in the pool. There is no
length limit beyond the pool itself.

A loaded recording appears under **In memory**, beside *all sample memory*. It
is not a sample: nothing plays it, it has no loop points, and it takes no
instrument slot. What it does have is its bytes, reserved — no import,
duplicate or [Housekeeping](#housekeeping) sweep will write over them or free
them while it is there.

Selecting one shows the map, scoped to that recording. Then:

- **Drag out a window** and hit *Cut instrument…*. The new instrument plays those bytes at the recording's rate. **Nothing is copied** — the instrument reads the recording's own memory, so editing that audio later changes both, and a hundred windows onto one recording cost a hundred instrument records and no extra pool bytes at all. Windows longer than 65535 bytes are refused, which is the whole reason for the ceiling.
- A **stereo** recording cuts stereo instruments: the same window of both channels, as one Ixmp pair.
- **Rename** and **Export** do what they say; Export writes the whole recording out as a WAV.
- **Delete** frees the bytes — except the windows already cut out of them, which keep their audio and go on playing. Deleting a recording is not deleting the instruments made from it.

The windows are ordinary samples once cut: they appear in the list under
**Samples**, they can be edited, looped, chopped and deleted like any other. Two
things follow from their sharing bytes with the recording, and both are the
point rather than a catch — the memory panel's *overlapping samples* note will
mention them, and the Sample Lab will not *change the length* of one in place.

The **Instruments** view's *From the list* picker (under **Sample ptr**) lists
the recordings in memory alongside the samples: choosing one points the
instrument at the first 65535 bytes of that recording, and the spinners beside
it move the window from there.

## The Sample Lab

The Sample Lab is *the* sample editor — a tiny Audacity that opens whenever
audio enters the project from outside (**Sample…** for audio files,
**Record…** for the microphone) and whenever you edit a sample already
in the project (the Samples view's **Edit…** and **Chord…**). It works on a
high-resolution float copy of the take, so every edit here happens *before* the
8-bit, 65535-frame pool format is committed — the one place where cropping and
resampling are still reversible.

- **Waveform** — drag to select a range; mouse wheel scrolls, Ctrl+wheel zooms at the pointer, and the Zoom/Fit buttons do the same from the bar. Space plays the selection (or everything); Delete cuts it.
- **Tools** — Crop (keep only the selection), Cut, Silence, Fade in/out, Gain… (dB), Normalise, Reverse, Invert, Remove DC. Tools apply to the selection, or the whole take when nothing is selected. The Lab keeps its own undo/redo (Ctrl+Z / Ctrl+Y) separate from the project's.
- **EQ** — an eight-band parametric equaliser (high-pass, low shelf, five peaks, high shelf) with a live response graph. Playback previews the bands in real time; **Apply EQ** renders them into the sample at 2× oversampling, which keeps bell and shelf shapes honest near the top of the spectrum.
- **Chop** (transient splitting) — the **Chop** button detects transients and splits the take into chunks, one flag per hit. Click the waveform to add a split, click a flag to remove it, and use the **Threshold** slider + **Detect** to re-run detection. Each chunk appears as a pill under the waveform: click its number to select it (audition with Space), untick it to leave it out of the import.
  - **Merging chunks** — removing a split flag joins the two chunks around it, so clicking a flag merges that pair. To merge several consecutive chunks at once, drag a selection across them and press **Merge** — every split inside the selection is removed and the chunks collapse into one.
  - **Import N chunks** lands every kept chunk as its own sample + instrument, named `name 1…N`, in a single undo step.
- **Chord…** opens the [chord maker](#the-chord-maker) on the take.
- **Mono / Stereo** — a stereo file or recording opens as a stereo take: two lanes, and every tool applies to both channels (Normalise uses one shared factor, so the image survives; transient detection listens to the mono fold). The **→ Mono** button folds the take down to one channel, halving what it will cost in the pool; **→ Stereo** splits a mono take back into a pair. Both are ordinary Lab edits — Ctrl+Z undoes them.
- **Rate and the frame budget** — the info line always shows what will land in the pool: each chunk is resampled to the target rate (32 kHz ceiling — the pool is 8 MB and a sample can hold 65535 frames, and 32 kHz is also the rate the TSVM device plays the file back at) with a band-limited Kaiser-sinc resampler (the same kernel the converters use), and anything still longer than 65535 frames is squeezed to fit with the rate following, preserving pitch. Both steps are irreversible once imported, which is exactly why the Lab shows them first — crop or chop until the numbers read the way you want.
- **Committing** — **Import as new** always mints new samples and instruments. **Replace** appears when the Lab was opened on a sample already in the project and writes the edit back over it, carrying every instrument bound to it along; see [Samples](#samples-f4) for what it will and will not do in place. When the Lab opened on a pooled sample, its loop region is shaded on the waveform and moves with your edits, so you can see where Replace will leave it.

### The chord maker

A tracker channel plays one note at a time, so the Amiga answer to "I want a
chord here" was to bake the chord into the sample itself. The **Chord…** button
does exactly that: it mixes up to six pitch-shifted copies of the working
buffer into one waveform. Reach it from the Samples view (**Chord…**, on a
sample in the project) or from inside the Lab, on anything you have just recorded,
imported or cropped.

Each of the six voices is a tick-box, a **mode**, one value, an octave and a
level — and the modes are independent, so voice 1 can be a just fifth while
voice 2 counts degrees of the song's tuning and voice 3 is a number you typed:

- **Just** — a named just interval, chosen from a list that shows each one's ratio and its size in cents (a perfect fifth is `3:2 · +702¢`). Always available, whatever the song is tuned to.
- **Degrees** — a signed count of degrees of *the song's own pitch table*, so the choices multiply with the tuning: 4 degrees is a major third in 12-TET and a whole tone in 24-TET. Counts wrap into the next period, and negative counts go down. On a notation with an absolute table (ProTracker) the count clamps at the ends, because those ends are every note it can express.
- **Ratio ×** — a playback ratio typed as a decimal: `2.0` is an octave up, `1.9632` is whatever `1.9632` is.
- **4096-TET** — a raw offset in note-word units, the same units the note column counts in; `0x1000` is an octave, and hex is accepted so `0x100` works as written.

**oct** shifts that voice by whole octaves on top of its mode, and **dB** sets
its level in the mix.

Every row reads out what it will actually sound: the ratio, the offset in
cents, the note it lands on painted in the song's own notation, and — when the
voice sits between two degrees — how many cents off that degree it is. A just
major third in 12-TET therefore shows up as `E-4` in the off-grid colour with
`off by −13 cents` beside it; the same third in 31-TET lands on a degree and says nothing.

- **Family** then **Chord** fill all six slots at once with a ready-made voicing. The vocabulary is far too long for one dropdown — a 31-TET project has 135 chords — so the family comes first and the chord menu holds one family at a time; changing family lands on that family's first chord and keeps your inversion, clamped to what the new chord has. The families are triads (major, minor, sus2, sus4, diminished, augmented), sevenths (including minor-major, half-diminished, diminished 7th and 7sus4), sixths and added notes (6, m6, add9, m(add9), add11, 6/9), the extended chords (major/dominant/minor 9ths, an 11th without its third and a 13th without its 11th) — or a spread: power, quartal, octaves, and **Detune (chorus)**, three near-unison copies that show what the manual ratio mode is for.
- **Neutral chords** appear when the song is in 17-, 24-, 31-, 41-, 53- or 96-TET. A neutral third is the exact centre of the third category — half the fifth, the point major and minor sit symmetrically either side of — which is why only a tuning that can spell that half is offered them, and why 12-TET is not: it halves its fifth at 350 cents and has no degree within 50 cents of it. The group runs neutral triad, neutral 7th, the neutral triad under the tuning's own minor or major 7th, a 6th, an add-9th, a 9th, and **Neutral chain**, which is the fifth halved and then the fifth above it halved again. 53-TET's fifth is an odd number of steps and cannot be halved exactly, so it offers both of the thirds that straddle the centre, labelled `11/9` for the flat one and `16/13` for the sharp one — the *artoneutral* and *tendoneutral* qualities.
- **Extraclassical chords** — *arto* and *tendo* — appear when the song is in a tuning that has a pair of them: 15-, 16-, 17-, 19-, 22-, 24-, 31-, 41-, 53- or 96-TET. An arto (inframinor) triad is a minor triad whose third has been pushed a further quarter tone down, a tendo (ultramajor) triad a major one whose third has been pushed up; both behave like the chords they came from, but sit far enough outside them to sound like neither. Their party trick is that they are *cross-tonal*: a major and a minor third clash over one root, whereas an arto and a tendo third are a whole tone apart and sound together happily, which is what **Cross-tonal**, **Cross-tonal 7th** and — where the arto third divides the fifth exactly three ways — **Slendric chain** are for. The family runs on from there: arto and tendo 7ths, a tendo dominant 7th and an arto-tendo 7th, 6ths, add-9ths and 9ths, plus arto-diminished and tendo-augmented triads in the tunings whose own notation can spell a quarter-tone alteration. 31-, 41- and 96-TET have more than one arto/tendo pair, so their entries name the just ratios each pair is nearest (`8/7·21/16` against `7/6·9/7`); and a tuning is only offered the chords it can voice, so 15-TET and 17-TET, whose tendo 7th would land on the octave, are not shown one. 22-TET arrives by a different road and needs no quarter tones: its fifth is sharp enough that its own minor and major thirds have already drifted out to arto and tendo (within 6 cents of 7/6 and 9/7), which is why its **Cross-tonal** chord is just its minor and its major third sounding over one root. 12-TET's thirds are nowhere near far enough out, so it is offered nothing.
- **Tetrachords** appear in the same menu when the song is in 17-TET, 22-TET or 31-TET, and only then: they are named in degrees of one tuning, so they mean nothing in any other. A tetrachord is the ancient Greeks' scale unit — four pitches spanning a perfect fourth, named by the three steps between them, `3-3-1` being the one the major scale is built from. The complete chart of each tuning is offered (15, 28 and 66 of them), with the names the Xenharmonic Wiki gives where it gives any: `3-3-1 · ionian (jins ʻAjam)` in 17-TET, `3-3-3 · diatonic · Porcupine, perfectly even` in 22-TET. Being a scale segment rather than a voicing, a tetrachord has no inversions — its order is the whole point of it.
- **Inversion** lifts the lowest voices an octave each, so the chord keeps its notes and sits on a different one: the 1st inversion of a major triad is built up from its third. Only the inversions a chord actually has are offered — two for a triad, five for a six-voice chord — and a chord that already contains its own octave (power, octaves) lifts past it rather than doubling a voice onto one it already has.
- **Length** — *longest voice* lets a voice below unison run past the end of the source (it plays slower, so it lasts longer) and keeps its whole tail; *source length* crops back to the original length, which is what you want if the result is going to loop; *shortest voice* crops to where the FASTEST voice runs out, so no voice is ever left playing on alone and the chord holds its full stack for every frame it has.
- **Normalise result** scales the mix to full scale. Leave it on: six copies at unity peak far above what 8 bits can hold, and the info line tells you what the raw mix peaked at.

**Preview** auditions the mix; **Apply** hands it back to the Lab as the working
buffer (one Lab undo step), where you name it, set its rate and import it like
any other take. The result is a plain one-shot sample — the voices are at
irrational ratios to each other, so a loop point that suits all six at once is
not something the mixer can arrange for you.

### Recording from the microphone

**Record…** (Instruments view) captures raw PCM from the microphone —
no lossy codec touches the take. A level meter runs while you record (up to
120 s); **Edit in Sample Lab** then opens the take for cropping and chopping
before anything reaches the pool. Browsers only expose the microphone on
secure origins, and will ask for permission on first use.

## Instruments (F5)

The left list shows every defined instrument slot; rows light up while an
instrument plays. Above it:

Two rows of three: the top row fills a slot from outside the project, the bottom row makes something new inside it.

- **New…** — pick presets from the bundled GeneralUser-GS SoundFont (or your own `.sf2`) and merge them in.
- **Sample…** — build instruments from any audio file (`.wav`, `.mp3`, `.ogg`, `.flac`, …). The audio is decoded to mono and opens in the [Sample Lab](#the-sample-lab) for cropping, EQ and chopping before it is committed to the engine's 8-bit format.
- **Import…** — merge instruments (with their samples and patches) from a `.taud`, `.sf2` or `.bnk` file. A checkbox picker lets you choose which; SF2 drum kits are the bank-128 presets. An AdLib `.bnk` needs no song alongside it — each patch you pick becomes a two-operator [FM Rack](#metainstruments-the-family-and-its-two-kinds), playable across the whole keyboard.
- **Record…** — record from the microphone; the take opens in the Sample Lab.
- **Paint…** — draw a waveform by hand and add it as an instrument.
- **Meta…** — build a **metainstrument**: one instrument made out of several of the project's instruments. A chooser asks which of the two kinds first — **Layered**, where every child is heard and the mixer sums them, or **FM Rack**, where the children modulate each other and only operator 0 is heard. Both are described below.

All imports are single undo steps.

### Metainstruments: the family, and its two kinds

A **metainstrument** is an instrument whose record holds a **table of other
instruments** where an ordinary one holds a sample. It sits in an ordinary
instrument slot, a pattern cell plays it like anything else, and what it sounds
is built from the instruments its table names.

*Metainstrument* is the family. Which kind a particular one is comes from its
record's type number, and there are two:

| Kind | Type | Its table is | What you hear |
|---|---|---|---|
| **Layered** | 0 | a list of **layers** | every layer the note falls inside, sounding **at once** — a voice each |
| **FM Rack** | 4 | an **operator rack** plus the algorithm that wires it | **one voice**: whatever the algorithm makes of them |

They share the table, byte for byte — the same sub-instrument, mix, detune and
pitch × velocity rectangle per row — and the editor gives each kind its own tab
over it (**Layers** and **FM**). What differs is what those entries *mean*: side
by side, or fed into one another.

### Building a Layered metainstrument

**Meta… → Layered** picks any number of ordinary instruments and stacks them
into a single new one. Each pick is **copied** into a sub-instrument slot
(`$100`+, a range pattern cells cannot address) and the copies become the
layers, so:

- the instruments you picked stay in the list, still selectable and jammable, and every pattern that already plays them keeps working;
- the copies share their sources' samples, so the stack costs no sample-pool space.

Each row of the picker has a **count**. Leave it at ×1 for an ordinary layer, or
raise it to stack the *same* instrument several times — the way a chorded or
unison instrument is built. A count above 1 makes **one** copy and points that
many **linked** layers at it, so the whole stack stays a single instrument you
edit once: retune or refilter it and every voice follows. The tally beside the
picker reads both limits that matter — the 25-layer table and how many voices a
note will now cost.

Every layer starts at unity mix (159 = 0 dB) across the whole note and velocity
range; spread and narrow them on the new instrument's **Layers** tab.
Metainstruments of either kind are not offered as picks — the engine resolves a
layer directly to a sample, so metainstruments cannot be nested.

### Building an FM Rack

**Meta… → FM Rack** takes the same picker and makes something quite different
out of it. The instruments you pick become **operators**, and instead of sounding
side by side they modulate each other: one operator's output bends where in the
waveform the next one is read, which is what turns two plain samples into a
sound neither of them contains. The whole rack is **one voice** however many
operators it has — the modulators are never heard directly, only what they did
to the carrier.

Order matters here in a way it does not for layers. The **first** instrument
picked becomes **operator 0**, the *principal*: it is the one that reaches the
channel, and its envelope, its fadeout and its sample ending are the note's. The
rack starts wired as a plain chain — the last operator modulates the one before
it, all the way down into operator 0 — and the **FM** tab is where that is
changed.

An operator's **loop is its cycle**, and that is the one thing worth knowing
before picking instruments. A single-cycle looped waveform gives textbook FM,
with the operator's *level* reading as a modulation index: at 0 dB the modulator
sweeps a whole cycle either way, and every decibel above that is brighter. Point
an operator at a drum hit or a long sustained sample instead and it scrubs
through the whole thing — a much stranger noise, and a perfectly good one.

Metainstruments are not offered as picks: an operator resolves straight to a
sample.

### Duplicating an instrument

The **Duplicate** button beside an instrument's name copies it into the lowest
free number in `$01`–`$FF` and selects the copy, ready to edit. This is how you
build a variant — a shorter fadeout, a different filter or envelope, another
zone map — without importing the same sound twice.

The copy **shares its source's samples**: only the instrument record and its
Ixmp patches are copied, so a duplicate costs one instrument number and no
sample-pool space at all. Editing the copy's *settings* never touches the
original, but editing the *sample* (in the Sample Lab, or by dragging its loop
markers) changes what both play, because it is one sample.

Duplicating a metainstrument of either kind copies its sub-instruments too — a
stack's layers, a rack's operators — into fresh `$100`+ slots, so they can be
retuned or refiltered without moving the original. Entries that shared one
sub-instrument still share one copy — the *linked ×n* relationship survives. The copy is named after its source with a
`(2)` (then `(3)`, …) suffix; rename it in the name box. One undo step.

### Renumbering an instrument

The **Renumber…** button beside an instrument's name moves it to another number
in `$01`–`$FF`. A number that is already taken is refused (free it first). Its
patches, its name and any metainstrument layer that uses it always follow the
move — that is internal wiring. Its **pattern cells** are a musical decision, so
they only follow if you tick *Point those pattern cells at the new number*;
left unticked, the notes keep naming the old (now empty) number. One undo step
either way.

### Editing an instrument

- **General** — global volume, volume swing, fadeout; default pan (which becomes **default azimuth**, and on a spatial song **default elevation**, once the song has a surround model — see [Surround panning](#surround-panning)), pan swing, pitch-pan separation and centre; wide-range detune (with hex-word and cents readouts); **New Note Action** (cut / continue / off / fade / key-lift), Duplicate Check Type and Action; filter mode (**ImpulseTracker** or **SoundFont2**) with cutoff and resonance shown in Hz/dB for SF2 mode. The Sample section binds the sample and opens the **play/loop/sustain marker editor** — draggable play-start, loop-start and loop-end markers, loop mode (off / forward / ping-pong / one-shot) and sustain, affecting this instrument slot only. Play start, loop start and loop end are all spinners here too, so a number read off the waveform's hairline can simply be typed in. **Auto loop** searches the sample for a loop region that plays without an audible click and writes the two markers for you: pick *cleanest*, *balanced* or *longest* (how much of a tick you will accept in exchange for keeping more of the sample) and it reports how long the loop is and how loud its seam is, in dB below the sound carrying it. It searches for whichever loop mode is set — forward and ping-pong click in different ways and want different loop points — and it only ever writes when you ask, so the numbers stay yours to adjust afterwards.
  - **From the list**, under *Sample ptr*, is the same binding as a list rather than an address: every sample in the pool, plus the [recordings loaded into memory](#long-recordings-in-memory) in a group of their own. Choosing one writes its pointer, length, rate and loop into this record in a single undo step; choosing a recording points the instrument at its first 65535 bytes, which the spinners then move. It is a copy, not a link — the list is *derived* from what the instruments point at, so a row can appear or disappear as you use it, and the row shown is always the one this record's own pointer lands on.
- **Vol env / Pan env / Pitch / Filter** — envelope graphs. Drag nodes vertically for values, horizontally for timing; a checkbox switches to a logarithmic timescale. The pitch/filter tab follows the instrument's envelope role.
  - **＋ Add node** and **－ Remove node** act on the node the spinners point at: adding splits the segment after it, or extends the envelope when that node is the last one, and removing merges its segment into the one before it so the timing after stays put. Node 0 is anchored at t=0 and cannot be removed; removing the last node shortens the envelope.
  - Adding a node also ticks **Envelope present** if it was not already ticked, in the same undo step — a node array is only read when that box is ticked, so editing an unticked envelope would otherwise be work with no sound to show for it. On the Pitch and Filter tabs the tick is also what claims the record's shared slot for that role.
  - That first tick switches **Sustain** on with it and carries its start and end to the new last node, so an envelope you are building arrives holding its final level until key-off rather than needing two more boxes found before any of it is audible. Untick either box and it stays unticked — the pair is only ever set by the click that brings the envelope into existence.
  - A **Sustain** point sitting on the last node follows it when you add another, so an envelope that holds its final level until key-off keeps doing that instead of turning into a hold halfway through. Sustain and loop points left pointing past the end are pulled back in when the envelope gets shorter.
  - **Carry** (beside *Envelope present*) makes a new note **continue** this envelope instead of restarting it: the playhead stays where the last note left it, so a slow pan sweep or a filter opening can run across a whole phrase of repeated notes rather than resetting on each one. Each envelope carries — or does not — on its own. It is ignored where there is nothing worth keeping: after a key-off, and on a note that changes instrument. This is also what makes a run of notes tied by `G` sound the same whether or not each row names its instrument.
- **Zones** — the Ixmp key/velocity zone map with a live trigger overlay showing which zone each incoming note lands in. The **Advanced Edit…** button opens the full patch editor (below).
- **Layers** (the Layered kind) — a Layered metainstrument plays several sub-instruments at once, and this table is the whole editor for that stack. Each row carries an editable **mix** (0–255, 159 = 0 dB, live dB readout), a **detune** in cents with ◂ ▸ buttons that step a whole degree of the song's own notation, and the **pitch** and **velocity** bounds that decide when the layer sounds at all. The ▸ beside row 0 marks the foreground layer: the first layer covering a trigger plays on the channel itself and the rest spawn background voices, so the order here is priority — **drag a row by the handle in its # column** to change it. The handle is a button as well as a grip: focus it and ↑ ↓ move the row without a pointer.
  - **Add layers…** brings in more instruments (the same picker, counts and all), **Duplicate** makes another voice of the layer's own sub-instrument ready to detune, and **Chord…** does a whole chord or unison spread in one action, using the same just intervals, chords and inversions as the [chord maker](#the-chord-maker). **Preview** there sounds the stack before you commit to it — the layer's own instrument at every pitch the panel lists — and stops on a second press, after a couple of seconds, or as soon as you pick a different chord. The layer you start from is the voice nearest unison and stays where it is, so an inversion decides which note of the chord that layer plays and the rest are placed around it.
  - Duplicated layers are **linked**: they share one sub-instrument, badged *linked ×n*, so editing it moves every voice of the stack together. When one voice needs to differ, **Unlink** gives that layer its own copy.
  - **fixed** beside the detune makes the layer **non-melodic**: it sounds one note whatever key is played, and the field beside the box stops being a detune and becomes that note — an absolute pitch, typed as a word (`$5000`) or a name (`C-4`), with ◂ ▸ still stepping degrees of the song's notation. This is how a layer that is a *sound* rather than a *pitch* is written: the click of a hammer, a breath, a bar of noise under the low keys. The pitch bounds still decide which keys reach the layer — the flag only fixes what it plays when one does — and everything else about it, mix and velocity bounds included, works as before. Ticking or unticking the box keeps the note the row was showing, so nothing jumps.
  - Each row's **Edit…** button opens that layer instrument in its own editor, with the same General / envelope / Zones tabs any instrument gets (its Advanced Edit lives on the Zones tab, as usual) — this is how you reach the sub-instruments of MIDI-imported instruments, whose layers are not listed on the left. A breadcrumb above the name walks back to the metainstrument that owns it.
  - The last layer cannot be removed (a metainstrument with no entries in its table is not one); delete the whole instrument instead.
- **FM** (the FM Rack kind) — the operator table above, the algorithm below. It is the same table as the Layers tab's, because a rack is the same record read another way, with two columns renamed for what they mean here: **level** is the operator's output level, which doubles as its modulation index when it modulates something, and **ratio** is its detune from the played note — an octave up is a 2:1 modulator, a twelfth is the inharmonic one that makes bells. The pitch and velocity bounds still gate: an operator whose bounds exclude the note falls silent for it, which is how a patch gets brighter as you play harder.
  - The ▸ beside row 0 marks the **principal** operator, whose envelope is the note's own. **Drag an operator by its handle** (↑ ↓ with the handle focused) and the algorithm is renumbered with it — the patch sounds exactly the same, but this is how the principal is chosen. The algorithm's own words reorder the same way.
  - The meter in the toolbar is the real limit. The operator table and the algorithm share one 252-byte record — 10 bytes an operator, 2 a word — so more operators means less room for wiring, and the bar shows both at once.
  - **Algorithm** is the wiring, shown three ways. The line beside the heading is the patch as an expression: `0[1[2]] + 3` reads "operator 2 modulates 1 modulates 0, and 3 is a second carrier beside it". Under it is the **diagram** — the picture an FM chip's manual prints, turned on its side so the signal runs left to right into OUT. A box is an operator, a wire into one is modulation, a curl over one is an operator modulating itself, and wires that meet are summed; a ring modulation or an inversion gets a mark of its own. Below that is the same patch as an editable list, one word a row.
  - The diagram only appears while the algorithm verifies — there is no picture of a patch that does not resolve, and half a picture would read as a working one.
- **Options** (both metainstrument kinds) — the record's own flag byte, which describes the whole instrument rather than any one entry in its table. It is quoted in hex beside the description, because that is what the file holds and what a bug report has to say.
  - **Percussion** stops **Transpose** and **Retune** from moving this instrument's notes, and gives it a stem of its own on export. Playback is unaffected — the engine ignores the flag, exactly as it does the same flag on an ordinary instrument.
  - **Strict layering** (Layered records only; greyed out on a rack, which has no layers to drop) changes what happens when a trigger falls inside a layer's rectangle but outside that layer instrument's own zones. Normally the layer sounds anyway and, matching no zone, falls through to the instrument's base sample — which is how a closed hi-hat ends up ringing under an open one. With strict layering the engine drops the layer for that note instead. Producers of Layered kits set it *and* give each layer instrument its own canonical zone, so that "no zone matches" unambiguously means "this layer has nothing to say about this note".
  - **An edit that does not verify is held in the editor, not written into the song.** Half-finished algorithms are normal — you cannot rewire a rack without passing through states that do not add up — so the words stay on screen and editable, marked in red under a banner, while the rack in the song goes on playing the last algorithm that worked. Repair the highlighted row and the whole held edit is applied as one undo step. Leave the FM tab and it is dropped, and the working rack is what you come back to.
  - A rack **already in the song** whose algorithm does not verify — a file from an older build, or from another tool — plays nothing, and says so under the same banner. Its operators are listed as usual; only the algorithm has to be written again.
  - Each word says what it does and what it does it to. **read** sounds an operator on its own; **read ×FM** sounds it modulated by whatever the words before it produced; **feedback** taps what an operator produced one sample ago, which is how a rack modulates itself; **combine** adds, ring-modulates, inverts, duplicates or swaps what is on the stack. The **≡** figure beside each row is how many values are stacked up after it — a finished algorithm ends on exactly one, and that value is the sound.
  - An operator no word names is badged *unwired*: it costs its bytes and makes no sound. That is also the only kind that can be removed — an operator the algorithm still names is guarded, because deleting it would leave words pointing at nothing.
  - If the algorithm does not add up, the expression line says why and the offending row is highlighted. A rack whose algorithm does not verify is silent rather than unpredictable.

### Advanced Edit (Ixmp patches)

An instrument may carry a list of **Ixmp patches**: per-zone sample bindings over a pitch × velocity rectangle, each optionally overriding envelopes, fadeout, filter and more. At trigger time the engine walks the list in order and the **first** patch whose rectangle contains the note wins; when none matches, the base instrument's sample plays. Advanced Edit is a whole-panel editor for this list:

- **Patch list** (left) — one row per patch plus the *base* fallback row. A ⚠ marks a patch whose rectangle overlaps an earlier one (**INVALID** per the format — use a Layered metainstrument for layering). **＋ Add**, **Duplicate**, **Delete** and **▲/▼** (match-order reorder) sit in the header; every action is one undo step.
- **Zone map** — the patches as rectangles over pitch (x) × velocity (y), with live blobs at each sounding note's pitch/velocity and lit rectangles for zones currently playing. Click a rectangle to select its patch.
- **Detail form** — the selected patch's rectangle, sample binding (pick any pooled sample — rate and loop follow), play/loop points, rate, detune, loop mode/sustain; pan / note-volume / auto-vibrato overrides (unchecked = inherit from the base instrument, and *Auto-vibrato override* covers all five of its fields at once — a zone with the box clear plays the instrument's own vibrato); and the *extra block*: per-patch fadeout, filter cutoff/resonance (IT or SF2 units) and SF2 initial attenuation.
  - **Pan** — the override is a *note* pan, so a bank whose zones pan apart keeps its spread wherever the channel is pointed, and `S $80xx` rotates the lot ([note vs channel panning](#note-volume-vs-channel-volume-note-pan-vs-channel-pan)).
  - **Stereo** — makes the patch play a [stereo pair](#stereo-samples): **Ch 2** picks the pooled sample that supplies the second channel (only same-length samples can pair up, since one set of loop points serves both), and **Mode** chooses `L/R` (the channels *are* left and right) or `M/S` (mid/side, decoded to L = M+S, R = M−S at mix time). Binding the patch to a stereo sample sets all of this for you.
- **Vol / Pan / Filter / Pitch** sub-tabs — per-patch envelope overrides. Ticking *Patch overrides the … envelope* copies the base instrument's envelope as a starting point; the graph then edits exactly like the base envelope tabs (drag nodes, add/remove, sustain/loop ranges, log timescale). **Wave** shows the bound sample with live play positions.

Jamming on the piano keys while the panel is open auditions the instrument live; the map, list and envelope graphs all follow the sounding voices. **‹ Back** returns to the normal tabs.

## Mastering (F6)

Everything else in Microtone is about writing the music. This tab is about
delivering it: how loud the song ends up, whether it clips, how much of the
8-bit code space it actually uses, and what the chain did to get there.

The chain is part of the SONG, not of the editor. It is saved in the file, and
anything that plays that file correctly plays it through the same chain — so
what you hear here is what everyone hears. Each song in a multi-song project
carries its own.

**The tab makes no judgements.** Nothing here looks at your music and decides
anything about it. Every stage is a textbook block with the control it says on
the tin, in a fixed order; in exchange you get an unusual number of meters, so
that if the tool will not tell you what is wrong you can see it yourself.

### The rack

Seven stages, in signal order, each with its own switch and one more for the
chain as a whole. With everything off the chain is not merely transparent — it
is absent, and the song renders exactly as it did before you opened the tab.

1. **Input trim** — level going into everything below. Set it once so the compressor threshold means the same thing from song to song.
2. **High-pass** — removes rumble and DC offset below the corner, at 12 or 24 dB/octave. Nothing musical lives down there, and what does live there eats headroom.
3. **Equaliser** — four bands with the response curve drawn above them, over a live spectrum of the music. All four start switched on at 0 dB, where an EQ band is exactly the identity, so turning the equaliser on and reaching for a gain slider does what it looks like it should. Band 1 can be a low shelf or a bell, band 4 a high shelf or a bell; the middle two are always bells.
4. **Compressor** — one band, with a soft knee. The detector is *linked* across the pair, so the stereo image stays where the mixer put it. **Peak** follows transients; **RMS** follows programme level over a 10 ms window and is the slower, gentler reading.
5. **Stereo width** — scales the side signal against the middle. 100% leaves the mix exactly as it was; 0% is mono; above 100% pushes it wider, and the Levels meters will show you what that costs the mono sum.
6. **Limiter** — a look-ahead brickwall. The ceiling is a promise, not a target: it is arranged so that nothing can overshoot it, on any material. Tick **True-peak ceiling** and it holds that promise against the 4× oversampled peak instead of the sample peak, so the file is still under the ceiling after a resample or a lossy encode. The limiter costs 2 ms of latency while it is on.
7. **Output gain** — the last thing in the chain, which means it sits *after* the limiter and can push the signal back over the ceiling. That is deliberate: it is the control the measure-and-set buttons write, and the meters will tell you if you have gone too far.

Every control is one undo step per gesture — a whole slider drag is one Ctrl+Z.

### Pre and post

The **pre / post** switch at the top decides which side of the chain the meters
read. *Post* is the master: what the file will hold. *Pre* is the mix arriving
at the chain — the untouched sum of your channels — so the two together are a
proper A/B of what the mastering did.

Both are measured every block, so switching is instant and the two readings
always describe the same moment. The input trim is inside the chain, so the pre
reading does not move with it.

### The spectrum behind the curve

The equaliser's graph draws the live spectrum of whichever side of the chain the
pre / post switch is on, filled from the bottom, with the response curve over
it. It is coloured **by band**, in the same five inks the Radiation and Cloud
scopes use — salmon, yellow, green, cyan, violet, low to high — so the same
frequencies wear the same colour wherever in the app you meet them.

Each column shows the loudest bin that falls in it, snaps up and falls away
slowly, which is what makes a spectrum readable rather than a flicker.

**It is tilted +3 dB per octave**, pivoting at 1 kHz. Real music is not flat —
its energy falls away with frequency at close to that rate — so an untilted
analyser hands most of its height to the bass and the top octaves, where a good
deal of what you are EQ-ing lives, never get to say anything. Tilting by the
slope the music already has makes a balanced mix read as roughly level, and
pink noise come out flat, which is what makes 3 dB/octave the standard choice.
The **spectral distribution** in the offline analysis is tilted the same way and
says so in its key. Nothing that is *measured* is tilted: the loudness, the
levels, the crest and the bit usage are all untouched by it.

### The instruments

- **Loudness** — ITU-R BS.1770 / EBU R 128. **M** is the 400 ms momentary reading, **S** the 3 s short-term one, **I** the gated integrated loudness of the current playback (it restarts with the transport). **LRA** is the loudness range in LU: how far the quiet and loud passages sit apart. **PLR** is the headroom the peaks keep above the integrated level, and it falls as a master is squashed. The bar draws the short-term reading with the momentary one as a bright tick over it.
- **Levels** — bars are RMS, the blue line is the true peak, the amber line is its falling hold. Two clip indicators, and they answer different questions: the **channel letter lights up** while clipping is actually happening and goes out again a moment later, and the **red tip past 0 dBFS** latches — once this take has clipped at all it stays lit until the transport starts another, because a clip thirty seconds ago is still in the file. **Click a lit red tip to clear it**, once you have seen it and dealt with it. One click clears every channel, and both sides of the chain — the gesture means "noted", not "noted, on this one bar".
- **Gain reduction** — how hard the compressor and the limiter are working. The bars grow leftward, because they are eating into the signal.
- **Bit usage** — which output codes the delivered file actually touches. A mix that peaks 12 dB down throws two of its bits away before any dither gets a say, and shows up here as a narrow spike instead of a spread. The centre line is digital silence. **Effective bits** is the span the signal swings over; **entropy bits** is how many bits the distribution is really carrying, and is always the smaller of the two.
  - The chooser in the panel's header picks **which delivery you mean**. *16-bit · WAV export* is the default and describes the stereo WAV: that export takes the mix bus straight to 16 bits and never touches the 8-bit stage at all. *8-bit · Taud device* describes what a conforming player delivers instead, dither and all — and at that depth the census is taken from the dithered output itself rather than by re-quantising the bus, because at eight bits the dither is most of the point.
  - At 16 bits, **codes used** against the **code span** is a second reading: a dense span is a signal that has really been worked at that depth, and a gappy one is a coarser source blown up to fit.

### Offline analysis

Live meters tell you what is happening *now*. **Analyse song** renders the whole
song as fast as the machine can and measures it every 100 ms, on both sides of
the chain at once, so a sag in the middle eight or a limiter working three times
as hard in the last chorus becomes something you can point at.

The summary lines give the whole-song figures for pre and post; the plot below
draws one measurement over the song's time axis, **dashed for pre and solid for
post**:

- **Loudness** — short-term LUFS through the song.
- **True peak** — the highest inter-sample peak in each 100 ms.
- **Crest** — peak over RMS, in dB. Low crest means a dense, flat waveform.
- **Phase-scrambled crest** — the same measurement after the signal has been run through an all-pass cascade that scatters its phases while leaving its spectrum alone. A clipped waveform has flat tops, and a flat top has an artificially *low* crest; scrambling the phases turns those tops back into peaks. So the **gap** between this reading and the plain crest is a direct measure of how much peak the processing has eaten — a fraction of a decibel on clean material, several decibels on something that has been hard-clipped. The summary prints the gap as a number for each side.
- **Spectral distribution** — where the energy was sitting, through the song. One column per 100 ms, the five bands stacked as their *share* of that column's energy, in the same colours as the spectrum behind the EQ curve and with the same +3 dB/octave tilt (its key says so). A bass-heavy passage is a tall salmon band, a bright one a tall violet one, and a mix that changes character halfway through says so. It is a distribution rather than a level, so a quiet passage reads the same as a loud one with the same balance — the column's opacity carries the level instead, and a silent tail fades out rather than showing the shape of its own noise floor. This one draws the side the pre / post switch is on rather than a pre/post pair.

The analysis stops at the length cap beside the button and says so when it does,
and it is thrown away when you switch song or open another project — it
described that music, not this.

### Measure and set

Three buttons under the plot read the analysis and write one number each:

- **Set make-up from peak** — moves the compressor's make-up so the render's true peak lands on your target in dBTP.
- **Set make-up from loudness** — moves the compressor's make-up so the integrated loudness lands on your target in LUFS.
- **Set input trim** — moves the input trim so the mix reaches the EQ and the compressor at the target loudness. This is how one threshold setting comes to mean the same thing on every song.

They are arithmetic, not advice: each one reads a measurement, does a
subtraction, and lands as an ordinary undoable edit you can see and change.
Nothing here decides whether the target was right for the song.

**Why make-up and not the output gain.** Make-up is where a master's level is
actually found: it drives the limiter, which is what holds the ceiling. The
output gain is the last thing in the chain and stays yours — nothing writes it
for you.

**Clicking twice does nothing.** Each button works out a whole make-up value
rather than a nudge: it takes the make-up the *analysis* was rendered at, adds
the distance that render missed your target by, and writes the result. Whatever
is in the box at the time is simply overwritten, so a second click computes the
same number and changes nothing at all. The buttons stay available.

**One click may not be enough, though.** Make-up sits before the compressor's
own curve and before the limiter, so moving it does not move the master by its
own decibels — the limiter eats some of it, and how much depends on the music.
One click gets you most of the way; if the target matters to the decimal, run
the analysis again and click again, and it converges. The panel marks the
figures as behind as soon as any edit lands, which is your cue.

Any other edit *does* retire the two make-up buttons until you re-run the
analysis, and that is the honest answer rather than a limitation: the numbers
were measured through a chain that no longer exists, and no arithmetic can
carry them across a threshold change. The **Set input trim** button is never
retired — the pre reading it works from sits upstream of the whole chain, so no
chain edit can invalidate it. The make-up buttons also need the compressor to be
switched on, since writing make-up into a bypassed stage would do nothing.

### What the chain reaches

The chain is part of the song, not editor state, so it reaches every delivery:
playback, the stereo WAV export, the multichannel and ambisonic exports, and
anything that plays your `.taud` correctly. What it acts *on* differs — the
stereo pair for the first three, the sound field's own channels for the fourth
— and the rest of this section is that difference.

The two deliveries are not the same depth. A **stereo WAV export is native
16-bit**: it takes the finished mix bus and writes it out directly, so the
engine's 8-bit stage — and its dither — never enter into it. The `.taud` file
itself is 8-bit, because that is what the format's own player produces. The Bit
usage panel can describe either.

A **multichannel or ambisonic export** gets the chain too, but as a
*multichannel master*, because those files are written from the sound field
rather than from the pair. Same parameters, one chain as wide as the file:
the trim, the high-pass, the EQ and the output gain go on every channel with
exactly the same settings, the compressor and the limiter each run **one**
detector reading all the channels at once, and the stereo width is skipped —
mid/side has no meaning across six speaker feeds, and forcing it would swing
the sound field about rather than widen it.

One consequence is worth knowing before you trust a meter. The linked detectors
mean the compressor and the limiter are looking at a different signal from the
one the Mastering tab shows you: the tab meters the stereo pair, and the
multichannel file's dynamics react to its loudest channel. The filters, the
trim and the gain do carry over exactly — those are the same numbers whichever
way the song is folded — but a limiter that never moves on the stereo master
can still be working on the 5.1 one. The limiter's ceiling holds on every
channel of the file it writes; it is not a promise about what somebody's
decoder does with those channels afterwards.

Stems are per-channel and by definition pre-master.

## Project (F7)

The tab opens with the **project's** own three strings — **Project name**,
**Author** and **Copyright** — followed by a **Message** box for whatever the
project wants to say to whoever opens it: liner notes, greetings, a track list.
The message travels with the file, and importing an ImpulseTracker module brings
its song message in here. All four are written as you type — the file reads as
unsaved straight away, and switching tabs or clicking into the other pane cannot
take a half-typed message with it — while a whole burst of typing is still one
Ctrl+Z. These describe the whole project; each song has its own name, composer
and copyright, which the songs table at the bottom edits.

Then the per-song properties, applied live to playback:

- **BPM** (25–535) and **Speed** (ticks per row, 1–127).
- **Rows per beat** and **Rows per bar** — the row highlighting the grids are banded with (display only). Also on the Timeline trough's right-click menu, see [The row trough](#the-row-trough).
- **Global volume** and **Mixing volume** (0–255).
- **Tone-slide mode** — Linear (4096-TET), Amiga period, or Linear frequency.
- **Interpolation** — Fast sinc, None (ZOH), Amiga 500, Amiga 1200, SNES gaussian, NES DPCM.
- **Panning model** — Stereo, Planar (360°) or Spatial (sphere); see [Surround panning](#surround-panning).
- **Notation** — the display pitch table. Changing it only relabels notes; use **Retune…** to actually move them (see [Microtonality in depth](#microtonality-in-depth)).
- **Tuning** — the concert pitch the whole song is played at (see below).

Below, the songs table lists every song in the project with its name, composer
and copyright; **Edit…** changes all three, **Delete** removes the song, and
**Add song** appends a fresh one. The top-bar selector switches between them.
Names, composers and copyrights — the project's and each song's alike — are
stored with `\uHHHH` escapes for non-ASCII and shown decoded; only the project
message is stored as plain text.

### Surround panning

The **panning model** decides what the pan commands mean, so it belongs to the
song rather than to playback:

- **Stereo** — the classic left/right pan. Nothing changes.
- **Planar (360°)** — sources pan all the way round you, on the horizon.
- **Spatial (sphere)** — sources can also go above and below.

In a surround song `S $8xxx` carries a **9-bit angle** instead of a pan byte:
`$000` left, `$080` front, `$100` right, `$180` behind, running clockwise as
seen from above. The low byte is the pan value you already know, so every
ordinary pan lands on the front half of the circle and a song that uses nothing
but ordinary pan sounds exactly as it did. Pan slides (P and the pan column)
wrap round the circle instead of stopping at the ends.

Three commands are yours only in a surround song. `X` writes the very same
**channel axis** `S $8xxx` does — not a third register — so it places the
*part*, exactly like `S $80xx` in a stereo song; a zone-panned instrument's
spread still rotates under it rather than collapsing to one point (see
[note pan vs channel pan](#note-volume-vs-channel-volume-note-pan-vs-channel-pan)).
It only trades the single byte for a sphere:

| Command | Meaning |
|---|---|
| **X** `$eeaa` | Place the source: `$aa` azimuth over the full turn (`$00` left, `$40` front, `$80` right, `$C0` behind), `$ee` signed elevation (`$00` ear level, `$40` = +45°, `$C0` = −45°). |
| **4** `$eeaa` | Aim: where a slide should travel to, same argument format. It stays set until you change it. |
| **Z** `$0xxx` | Slide there at `$xxx`/16 azimuth units per tick, along the shortest way round. Like every other slide it runs on the row that carries it, so repeat it while you want the source moving; `Z $0000` recalls the last speed. |

A **stereo sample** in a surround song is placed as a pair of sources 30° either
side of where the voice points — the ITU listening triangle — and the pair turns
with the voice instead of being nailed to the speakers.

**Where an instrument starts.** The Instruments view's *Default pan* becomes
**Default azimuth** in a surround song — the full circle, not just the front
half, so an instrument can sit behind you without a single command in the
pattern — and a spatial song adds **Default elevation** beside it. Both apply on
a note that carries an instrument number, and only when the instrument's *Use
default pan* box is ticked. They are stored in bits that older files leave
clear, so nothing you already have changes, and a stereo song ignores them
entirely. An instrument's Ixmp zones can still override the azimuth (they carry
their own pan) but not the height, and a zone's pan applies whether or not the
box is ticked — the box gates the instrument's own default, not the zones'.

**The panner.** Rather than working the angles out by hand, press **Panner…**
on the Timeline or Patterns toolbox (it appears once the song is planar or
spatial). It draws the circle from above — plus a side view for elevation on a
spatial song — with a dot for every channel that is sounding, drawn where the
engine actually has it, so a Z slide is visible while it runs. Drag the handle
or type the numbers, then press one button to write the command into the cell
under the cursor: **Place** writes X, **Target** writes 4, **Slide** writes Z at
the speed in the box. Each button shows the exact command it will write, and
each write is a normal undo step.

**Watching it from the Timeline.** In a surround song each channel header's pan
strip shows the source's *shadow* on the left–right line — height and depth
collapse onto it, so a hard-left source 60° above you reads half-left, and one
directly behind reads centre. Press **Radar** in the toolbox and every header
expands into a small dial seen from above: the source goes round the circle by
azimuth, elevation pulls it toward the middle (straight overhead is dead
centre), a spatial song adds a height bar at the right, and a tick on the
horizon line marks the same shadow the strip is showing. Press it again to
collapse.

On a **spatial** song the dots carry their height with them, in the panner and
in the headers alike: a source grows as it rises above ear level and shrinks as
it sinks below, and it casts a shadow from an imaginary light high up in front
of you — pressed against the dot and sharp when the source is low, drifting
below it and softening as it climbs. A dial drawn from above cannot otherwise
tell you whether a source is over your head or under your feet.

**Hearing it: the head model.** A surround song is monitored through a
**binaural** head model by default — the **Binaural** toggle sits next to Radar
in the toolbox. It gives each ear its own arrival time and its own shading of
the sound, so on headphones a source behind you sounds behind you and one above
you sounds above you, which is the only way to compose a position you can hear.
The filters are *measured* — the SADIE project's set, recorded from a real head
for Google's VR work — rather than a model fitted by ear, so what you hear is
what a head does with a sound coming from there, down to the notch your own
outer ear puts in a sound from above. Some directions are a little quieter than
others because a real head makes them so: behind you loses a few decibels, and
under your feet more, which is part of how you know where they are.

It costs some CPU (roughly a doubling of what a surround song costs to play),
and it is meant for headphones; switch it off to hear the plain **stereo fold**
everyone gets who never touches the surround controls. The fold mirrors what is
behind you onto the front (two speakers cannot do front and back), leaves left
and right where they are, and pulls height toward the centre.

**Getting it out.** **Export audio…** on the Files tab (F9) offers the whole
range — stereo, quadraphonic, 5.1, 7.1 and ambisonic B-format — with a picture
of each channel layout; see [Import and export](#import-and-export).

The panner's **This channel only** box hides every other channel's dot, for when
a busy song makes the dial hard to read.

### The wide pattern cell

Turning a project surround also **upgrades its file format** — to version 3,
whose pattern cells are twice as wide. The editor tells you before it happens
and writes the upgraded project to a **new file**, leaving the original exactly
as it was; there is no way back, and the TSVM device cannot play a version-3
file. A project created as Planar or Spatial in the **New…** wizard starts out
this way.

What the extra room buys you:

- **An 8-bit volume column.** Volumes run 00–FF instead of 00–3F, so the column has four times the resolution — and its own slides can move by a single unit per tick. Effect-column volume slides (`D`, `K`, `L`, `N`) keep their old arguments and their old speed.
- **A panning column that holds a position.** Instead of one front-arc value, it carries the **height** (two digits, signed: `00` ear level, `40` = +45°, `C0` = −45°) followed by the **angle** (three digits: `000` left, `080` front, `100` right, `180` behind). The height is drawn in its own colour so the two numbers never read as one, and in a **spatial** song a placed source states its height even when it is `00` — on the sphere, ear level is a position you chose, not an absent value (a planar song has no height to state, and a slide leaves the field unused, so both show dots there). A `Z` slide on the same row turns the column into that slide's *target*, so the source travels there instead of jumping.
- **A second effect column.** Every cell carries two effect slots instead of one, and the second runs straight after the first on every row and every tick — so two commands that used to fight over one column can both be written. Converters use it so nothing from a source file has to be discarded; you can write it yourself the same way you write the first one.

#### Showing the second effect

The second effect column is **hidden by default**: most songs never write one, and it is six more characters in the widest column on the screen. Three ways to bring it out, all of them in version-3 projects only:

- **2nd FX** in the toolbar shows or hides it on *every* channel and every pattern column at once.
- **Right-click a channel header** in the Timeline for that one channel — the menu's second row carries **2nd effect** beside the mute controls.
- **The E2 button** at the top of a Patterns column, for that column alone.

A channel that is *hiding* second effects it actually contains says so: an amber **E2** appears beside the channel number in the Timeline header, and the Patterns column's E2 button is outlined in the same colour. Hiding the column never changes what plays, and never changes what is in the file — a hidden second effect survives copy, paste and delete untouched, because a selection only ever reaches the columns you can see.

Once it is showing, it edits exactly like the first effect: the same opcode letters, the same four argument digits, the same command palette at the foot of the screen, and the same right-click quick-effect cells.

**The two effect columns swap freely.** Select one of them, copy, put the caret in the other and paste — the command moves across. The caret is what picks the slot, so the same copied effect can go to the first column in one place and the second in another, and the slot you are not pasting into keeps whatever it had. A block covering *both* effect columns (or a whole cell) is not ambiguous, so it always lands in the columns it came from. A second effect will also paste into a version-2 project's effect column, since there is nothing in one that an ordinary effect column cannot hold.

The **Panner…** dialog gains a **Column** button in such a project: it writes the
position into the panning column and leaves the effect slot free.

Everything else works as before — the same keys, the same symbol cell, the same
`Del` to clear a column.

### Tuning

Tuning declares **what frequency one named note actually sounds at**, and the
engine plays the whole song at that reference. It is a property of the song, not
of the notes: it slides every voice together, leaving the written music and the
notation untouched. Two controls plus a preset list express it:

- **Tuning** — the standard tunings: A4 @ 440 Hz (ISO), A4 @ 435 Hz (French, 1859), A4 @ 452 Hz (Old Philharmonic), C4 @ 256 Hz (power of two), C4 @ 262 Hz (Chinese *a-ak*), C4 @ 311 Hz (Korean *hyang-ak*), and the tracker default.
- **Base note** and **Frequency (Hz)** — pick any reference yourself. The pair is redundant, so A4 @ 440 and C4 @ 261.6256 describe the same tuning; use whichever you think in.

The line underneath always reports what the song *sounds* like — the resulting
A4 in Hz, and how far that is from concert pitch in cents.

**The tracker default is not concert pitch.** A file converted from a tracker
module (`.mod`, `.s3m`, `.it`, `.xm`) declares the Amiga convention — C9 @
8363 Hz — which puts A4 at about **439.53 Hz, roughly 1.87 cents flat of 440**.
That is not an error: it is what the hardware those songs were written for
actually did, so the module plays at its native pitch. MIDI imports declare
A4 @ 440 and play at concert pitch.

Tuning and **Retune…** solve different problems, and it is worth keeping them
apart:

| | Tuning | Retune… |
|---|---|---|
| Moves | the whole song, as one | each note, individually |
| Changes the written notes | no | yes |
| Use it for | "this piece is at A = 412" | "re-express this piece in another pitch table" |

*Note:* tuning retunes playback; it does not re-tune the samples themselves. If
a sample was recorded off-pitch, correct it with the instrument's detune rather
than by bending the whole song around it.

### Housekeeping

Five clean-up operations, each a single undo step:

- **Cleanup patterns** — drop the patterns no cue references, renumber the survivors and rewrite the cues to match.
- **Renumber patterns** — compact every pattern into play order, dropping the gaps.
- **Cleanup instruments & samples** — remove instruments no pattern plays (a used metainstrument keeps its sub-instruments, layers or operators) and free the sample data only they referenced. [Recordings loaded into memory](#long-recordings-in-memory) are never touched: nothing claims them by design, and they are source material rather than leftovers.
- **Cleanup instrument patches** — remove [Ixmp patches](#advanced-edit-ixmp-patches) that can never be triggered: patches belonging to no instrument, patches with an empty rectangle or no sample, and patches lying entirely under a higher-priority one (remember the *first* matching patch wins, so a fully covered patch is dead weight).
- **Defragment sample memory** — slide every sample down against the start of the pool, closing the [gaps](#sample-memory) that deleting and replacing samples leave behind. The other four free memory; this one is the only one that moves any. What it buys is the free space as **one run** instead of a dozen pieces too small to import into, and the confirmation says how big that run becomes before you commit. Every instrument, patch and recording that pointed into the moved memory is repointed with it, so nothing about the music changes — a defragmented project renders identically. Samples that overlap each other travel together, and a sample pointing *outside* the pool stops it: run **Cleanup instruments & samples** first, which drops the junk records that claim those addresses.

### Global Operations

Miscellaneous edit functions that affect **every pattern of the current song**,
each a single undo step. They stop at the song's edge: the other songs of a
multi-song project are never touched — switch songs and run the operation again
if you want them changed too.

- **Transpose** — the [Patterns](#patterns-f3) tab's Transpose applied song-wide: the same notation-aware fine/coarse units, and the same skipping of sentinels and percussion instruments.
- **Change instrument** — changes every note referencing one instrument to another.

## File (F9)

The File view works even before anything is loaded (**F9** from the empty
screen).

### Browser storage (OPFS)

Projects are saved into the browser's **origin-private file system** — private
storage owned by the site, never uploaded anywhere. The table lists your saved
projects with size and modification time; **Open** loads, **✎ Rename** changes
the file name (renaming the currently-open project keeps it current, so a later
Save targets the new name), **⬇** downloads a copy, and **✕** deletes.
In private-browsing mode OPFS may be unavailable — a warning appears, and you
should use **Export** to keep your work.

### Saving and autosave

- **Save** (**Ctrl+S**) writes the current project into OPFS; **Save As…** under a new name.
- The app **autosaves** 45 seconds after your last edit. If the browser closes with unsaved work, the next visit offers to recover it; declining discards the autosave. A clean save removes its autosave.

### Import and export

- **Import Taud/Module…** — bring a file from your real disk into OPFS.
- **Import MIDI…** — convert a MIDI file and save the result straight into OPFS.
- **Demo songs…** — open one of the bundled projects; see [Demo songs](#demo-songs).
- **Export ⬇** — download the project as a `.taud` file.
- **Export audio…** — render the current song offline through the same engine. Pick a target from the pictures, a sample rate and a maximum length (songs that never HALT stop at the cap). Every target is the same song re-rendered, not a downmix stage bolted on the end:
  - **Stereo** — 16-bit, the ordinary file. For a surround song you also choose how it comes down to two channels: **Fold** (the safe choice for speakers) or **Binaural** (keeps height and front/back, for headphones).
  - **Quadraphonic / 5.1 / 7.1** — 24-bit speaker feeds at ITU angles, with the channel mask and ADM metadata a DAW needs to know which channel is which. The LFE is left silent; there is no bass management here, and a mastering engineer will want to do that themselves.
  - **Ambisonic 1st / 2nd / 3rd order** — 24-bit AmbiX B-format (ACN order, SN3D normalisation) with ADM HOA metadata, saved as `<name>.ambix.wav`. This is the only export that keeps the full sphere: the listener's own decoder places it on whatever they have, headphones included. Higher orders are sharper and larger — third order is sixteen channels.
  - Your [mastering chain](#mastering-f6) comes with every one of these. Stereo gets the master you hear; a multichannel target gets a *multichannel master* instead — identical filtering and gain on every channel, one compressor and one limiter linked across all of them, no stereo width. The dialog says so when the song has a chain.
  - Height only survives into B-format. A speaker layout spreads an overhead source evenly around the ring (it has nowhere else to go), and stereo folds it toward the centre. A stereo song can still be exported to any of these; it is simply promoted to the planar model first, which sounds the same for ordinary panning.
- **Export stems…** — render the song into one 24-bit 48 kHz mono WAV per track, delivered as a single ZIP. A filename prefix is required; tracks come out as `<prefix>_01_<name>.wav`. Choose how they are arranged:
  - **Per instrument** (default) — one track per instrument as it appears in the pattern. A percussion instrument is split further, one track per kit piece, so kicks, snares and hats arrive separately; a drum layered from several sub-instruments stays on one track.
  - **Per voice** — one track per channel. Note-off ghosts and layered notes follow the channel that spawned them.
- Stem tracks are **dry**: every volume is baked in (note and channel volume, envelopes, fadeout, instrument volume, song global/mixing/master volume) but panning is not, so a hard-panned part arrives at full level and you re-pan it in your DAW. Because panning is left out, the tracks do not sum back to the stereo mix, and the Amiga post-mix filter (a mix-stage effect) is not applied to them. Nothing is dithered — 24 bits sit well below the engine's own noise floor.

## Importing music

All conversion runs **inside your browser** — the canonical Taud converter
scripts execute under a bundled Python runtime. The first import boots the
runtime (a few seconds); a progress popup streams the converter's log.

### MIDI

MIDI needs a SoundFont for its instruments. Use **Import MIDI…** and choose
the **bundled GeneralUser-GS** bank or pick your own `.sf2`. The result loads
as an unsaved project. A few options shape the conversion:

- **Rows/beat** — pins the pattern grid. *Auto* picks it from the time signatures and note onsets.
- **Keep duplicate patterns** (off by default) — the converter normally stores one copy of each distinct pattern and points every cue that repeats it at that same copy, so a song that plays the same bar eight times spends one pattern on it (and a column that is silent all the way through costs exactly one for the whole song). That is compact, but it also means editing such a pattern in one cue changes it in every cue that shares it — the [Patterns](#patterns-f3) view names the cues that would follow along. Tick this box and each cue gets its own private patterns, so the import behaves like something you tracked by hand. The music is note-for-note identical either way; only the pattern count differs, and duplicates cost almost nothing on disk because they compress away.
- **Quantise timing** (*Off* by default) — snaps every note onset onto a beat grid. A MIDI that was **played** rather than stepped in carries its performance in the sub-row note delays the converter writes, and quantising throws those away: swing, flams, grace notes and any deliberate push or drag go with the mistakes. That is why it is off. When a sloppy take is what you have, *Auto* snaps to the subdivision the piece already uses, *Tracker rows* snaps to the pattern grid itself (after which no note needs a delay at all), and the fractions snap to a fixed beat division. Both ends of every note are snapped, the onset and the release, so a quantised note lasts a whole number of grid steps rather than keeping the ragged release it was played with. Notes shorter than half a step stay as short as the grid can hold them, so a drum hit or a grace note is not fattened into a sixteenth; where that leaves two strikes of the same key on one grid point, they become the one strike they now are.
- **Import stereo instruments in stereo** (off by default) — SoundFont instruments built from a stereo sample pair normally arrive mixed down to mono. Tick this to keep both channels as a [stereo sample](#stereo-samples); it doubles what each such instrument costs in the 8 MB pool, so a big bank may end up resampled harder to fit. The same option appears on the **Import MIDI…** dialog and on the SoundFont preset picker (Instruments → Import…).
- **Trim unused patches** (off by default) — each SoundFont preset is imported with its **whole** key/velocity zone map, so an imported instrument stays playable across the entire keyboard, not just at the notes this particular song happens to use. The extra zones are inert: the song sounds exactly the same either way. Tick the box to keep only the zones the song triggers, which makes the bank considerably smaller. You can always trim later with **Project → Housekeeping → Cleanup instrument patches**.

  One caveat worth knowing: the converter's sample pool is capped at 8 MB, and
  when a bank overflows it, *every* sample is resampled down to fit — costing
  audio quality across the whole song. Most MIDIs stay well under the cap
  untrimmed, but a preset-heavy one (say 30+ distinct instruments) may not.
  If the import log reports `sample pool overflow`, re-import with **Trim
  unused patches** ticked.

### Tracker modules

`.mod`, `.s3m`, `.xm`, `.it` and `.mon` files convert directly — just open or
drop them. An `.it` whose samples are stereo keeps them as
[stereo samples](#stereo-samples) — the other formats have no stereo samples to
begin with.

### AdLib songs

`.ims` files — **Iyagi Music Sound**, the music format of the Korean BBS
terminal *Iyagi*, played on an AdLib card — open the same way, and arrive as
**FM Racks**: every instrument the song names is compiled into the two-operator
patch the chip played, over single-cycle samples of the chip's own waveforms,
and is editable operator by operator ([Building an FM Rack](#building-an-fm-rack)).

These songs **name** their instruments instead of storing them, so they need a
bank file. Drop the song and its `.bnk` together — or select both in **Open…** —
and they are matched up; without one, the general AdLib bank that ships with
Microtone resolves nearly every patch name in circulation.

The conversion sets its own tempo and speed: the row grid comes from the song's
own timing, and the tick is made as short as the tempo register allows, because
the tick is what the envelope resolution is. A converted song therefore shows a
much higher BPM and a much larger speed than a tracker module would — 480 BPM at
speed 8 is one row every 62 ms, exactly as before.

What you are handed is an ordinary **A4 = 440 Hz, 12-TET** song, and its cues are
a whole number of **bars** rather than a flat 64 rows — a song at 12 rows to the
beat gets 48-row cues, one bar each, instead of cues that straddle the bar line.

## Microtonality in depth

### Pitch-table presets

The available notations (the preset also defines the note symbols used in the
grid):

| Preset | Notes per period | Period |
|---|---|---|
| Raw format | — (raw hex words) | octave |
| ProTracker Temperament | 12 | **none** — every note listed (see below) |
| Octave only | 1 | octave |
| 2- to 10-TET | 2–10 | octave |
| 12-TET | 12 | octave |
| 15-, 16-, 17-, 19-, 22-, 24-, 31-TET | as named | octave |
| 41-TET (Kite), 53-TET (Kite) | 41 / 53, Kite up/down tick notation | octave |
| 53-TET (Pythagorean) | 53, letters with stacked sharps/flats | octave |
| 96-TET (Kite) | 96 | octave |
| Pythagorean dim. 5th / aug. 4th | 12, just fifths | octave |
| Shi'er lü | 12, 十二律 CJK names | octave |
| Equal-Tempered Bohlen-Pierce | 13 | **tritave** (3:1) |

**ProTracker Temperament** is the tuning of Amiga `.mod` files, and imported `.mod`s
select it automatically. ProTracker does not tune by 12-TET: it plays from a
table of integer Amiga timer periods, leaving most notes up to about 6 cents
away from the 12-TET grid — which is why a `.mod` read as 12-TET shows most of
its notes yellow. The table is not even exactly octave-repeating (ProTracker's
E-3 is period 170, where a strict octave below E-2 would be 169.5, leaving it
5 cents flat), so this preset has **no period at all**: it simply lists every
note ProTracker can play — the original three-octave ProTracker table together
with the two extra octaves adopted by later trackers. Notes therefore step by
semitones as usual, but stepping stops at the ends of the table, because that
is the whole range the tuning can express.

`.mod` files imported before this notation existed still carry 12-TET and will
look out of tune. To fix one, open the Project view and **Retune…** it to
ProTracker Temperament with the *Nearest pitch* method.

Note display uses proper microtonal accidentals — sharps, flats, demisharps,
demiflats, double/triple/quadruple accidentals, Kite tick marks — and degree
octave labels where letters run out. Notes more than two units off the active
grid render snapped-but-**yellow**; the **Raw** toolbox toggle shows exact hex
words instead.

### Retuning

**Retune…** (toolbox or Project view) remaps every pattern note onto a new
pitch table, as one undo step. Percussion instruments are skipped. Four
methods:

- **Nearest pitch** — snap each note to the closest new-table degree.
- **Nearest delta** — preserve the melody's shape: each note keeps the interval from the previous note as closely as possible.
- **Nearest cadence** — like delta, but scores candidates by how well they reproduce the original's rise and fall of tonal tension.
- **Cadence-aware harmonic** — delta plus a pull toward just-intonation intervals, weighted by note duration (held notes pull harder).

For non-destructive experiments remember **Ctrl+Z** restores the previous
tuning exactly.

### The Notation Maker (custom notations)

When no preset fits — a Scala scale, a temperament of your own, a non-octave
system — open the **Notation Maker…** from the Project view's notation row.
A project holds up to **16 custom notations**; each definition is saved inside
the project file (the `nota` section) and appears in the notation selector and
the Retune target list like any built-in preset. Custom notations are
display-and-entry only: they change how notes are written and stepped, never
how anything sounds.

Three ways to fill a slot:

- **Import .scl…** — load a [Scala scale file](https://www.huygens-fokker.org/scala/scl_format.html). The scale's last pitch becomes the period (octave, tritave, anything), the other pitches become the degrees, and every degree gets an automatic name.
- **Click an empty slot** — start from a 12-equal seed and reshape it by hand.
- **Import .taudnot…** — load a definition exported from another project.

The editor shows one row per degree: its pitch in **cents** (and the exact
4096-TET word), plus a symbol built from three parts — a **tick** (Kite-style
dot/arrows), a **letter** A–Z and an **accidental** (♮ ♯ ♭ demi, double,
triple, quadruple) — with a live preview drawn by the same glyph engine as the
grids. **Equal divisions…** refills the table with N equal steps of the
period; the two **Auto-name** tools assign symbols by nearest quarter-tone or
as a plain letter sequence. The letter sequence spreads the degrees over all
26 letters and tells the ones sharing a letter apart by a variant ladder:
ticks while a letter carries up to five degrees, then accidentals (♭♭♭ … 𝄪𝄪),
then both crossed — enough for a unique symbol per degree up to 1300 of them.
Degree 0 is always the base note — **Middle C
($5000)** unless the notation declares its own (below) — and this anchor is
what keeps non-octave systems well-defined.

**Notations without a period.** Most tunings repeat at some interval, but a
few don't — ProTracker Temperament, for instance, is a hardware table that is only
*approximately* octave-periodic. For these, pick the **No interval** chip: the
table then lists **every note the notation can express**, absolutely, and two
things change. A **Base note** field appears — the absolute pitch degree 0
sits on (hex, C4 = `$5000`; set it lower to reach notes below Middle C, e.g.
ProTracker's shape would use `$3000`). And **Equal divisions…** asks for
*steps per octave* × *octaves spanned*, since there is no period to divide.
Stepping and transposing in such a notation clamps at the ends of the table —
the table **is** the tuning's whole range.

**Save** stores the definitions as one undo step; with **Use for this song**
ticked the current song's notation switches to the edited slot immediately.
**Export .taudnot** shares a definition as a small standalone file.

## Effect commands

A quick digest — the full specification with per-tick semantics, memory
behaviour and worked examples is the **Note Effects** reference in the
sidebar (also at [Note Effects](#effects)).

| Op | Name | Argument |
|---|---|---|
| 1 | Global flags | `$ff00` — tone-slide mode and interpolation bits |
| 2 | Sample mod (outside) | `$sexy` — as 3, but `se` is the region left alone |
| 3 | Sample mod (region) | `$sexy` — region (of the loop), operation, step period in ticks |
| 4 | Spatial slide target | `$eeaa` — elevation, azimuth |
| 5 | Filter cutoff | IT: `$xx00` · SF2: `$xxxx` absolute cents · `$FFFF` reset |
| 6 | Filter resonance | IT: `$xx00` · SF2: `$xxxx` centibels · `$FFFF` reset |
| 7 | Pattern ditto | `$llrr` — repeat the last `ll` rows `rr` times |
| 8 | Bitcrusher | `$xyzz` — clip mode, bit depth, sample-skip |
| 9 | Overdrive | `$x0zz` — clip mode, gain (16+zz)/16 |
| A | Set tick rate | `$xx00` — ticks per row |
| B | Jump to cue | `$xxxx` — order jump |
| C | Pattern break | `$00xx` — next cue at row xx |
| D | Volume slide | `$xy00` — up/down per tick; `F` nibble = fine |
| E | Pitch slide down | `$xxxx` units/tick · `$Fxxx` fine |
| F | Pitch slide up | `$xxxx` units/tick · `$Fxxx` fine |
| G | Tone portamento | `$xxxx` — slide toward the row's note |
| H | Vibrato | `$xy00` — speed, depth |
| I | Tremor | `$xy00` — x+1 ticks on, y+1 off |
| J | Arpeggio | `$xy00` — microtonal offsets ×256 for voices 2/3 |
| K | Vibrato + vol slide | `$xy00` |
| L | Portamento + vol slide | `$xy00` |
| M | Channel volume | `$xx00` (00–3F) |
| N | Channel vol slide | `$xy00` |
| O | Sample offset | `$xxxx` — start at byte offset |
| P | Pan slide | `$xy00` — left/right |
| Q | Retrigger | `$xy00` — every y ticks, x = volume modifier |
| R | Tremolo | `$xy00` — speed, depth |
| S | Special | delays, cuts, loops, waveforms, NNA overrides, invert loop… |
| T | Tempo | `$xx00` set · `$FFxx` extended · `$000y/$001y` slide |
| U | Fine vibrato | `$xy00` |
| V | Global volume | `$xx00` (00–FF) |
| W | Global vol slide | `$xy00` |
| X | Spatial panning | `$eeaa` — elevation, azimuth |
| Y | Panbrello | `$xxyy` — speed, depth |
| Z | Special 2 | `$0xxx` spatial slide · `$Ffxx` funk repeat: hop the loop through the sample, `$f` = the hop |

### Ditto ghosts

Effect 7 repeats earlier rows without copying them, so the repeated rows look
empty even though they play. The Timeline and Patterns grids therefore paint
the **would-be-repeated values in grey** on every row a ditto covers — the note,
instrument, volume, pan or effect that will actually sound, taken from the row
being repeated.

Grey means "not really here": ghosts only ever fill sub-columns the row leaves
blank, and anything you type wins immediately and returns to its own colour.
The row carrying the `7 $llrr` command keeps showing that command, even though
the engine plays the repeated row's effect there instead.

To say "**nothing** happens here" and stop a ghosted effect reaching a row, put
effect `0` on it with any non-zero argument. Effect 0 does nothing whatever its
argument, but the cell is no longer blank, so the ditto has nothing to fill —
and because no part of the argument is read, the grids draw all four digits
dim, which is how an explicit blank tells itself apart from a command.

Starting playback **from a ghost row** sounds it: seeking into the middle of a
ditto region rebuilds the repeat so the note you see in grey is the note you
hear, exactly as if you had played through the arming row.

## Keyboard reference

### Global and navigation

| Keys | Action |
|---|---|
| Enter | Play from cursor / stop |
| Shift+Enter | Play from start |
| F1…F7 · F9 | Switch views |
| F8 · Shift+F8 | Split the view in two / close the pane · the other pane |
| Space | Record mode on/off |
| [ ] | Octave down / up |
| M / N | Mute / solo the cursor channel (navigate mode) |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Save to browser storage |
| Ctrl+G | Go to cue:row |
| Shift+arrows · drag | Extend a block selection |
| Ctrl+C / X / V | Copy / cut / paste the block |
| Esc · Delete / Backspace | Clear the selection · blank the block |
| ? | Keyboard help popup |

### Editing keys

| Keys | Action |
|---|---|
| A S D F G H J K L ; | Piano white keys (C D E F G A B C D E) |
| W E · T Y U · O P | Piano black keys |
| Q · R · I | Half-sharps where a piano has no black key |
| z x c v | Key-off `===` · cut `^^^` · fade `~~~` · fast-fade `~^~` |
| 0–9 A–F | Hex entry (instrument / volume / pan / fx argument) |
| 1–Z | Effect opcode (base-36) |
| ^ v / u d | Volume symbol cell: slide up / down |
| > < / r l | Panning symbol cell: slide right / left |
| + = / - | Symbol cell: fine slide up / down (right / left) |
| Delete / Backspace / . | Clear the field — on a symbol cell, plain set |
| ← → / Tab | Sub-column / next channel |
| wheel · Shift+wheel | Scroll rows · channels |
| wheel on cursor cell | Step the hovered column (notes by one table degree) |

## Tips

- **No sound?** Click anywhere or press a key — browsers keep audio suspended until a user gesture. The top-bar badge shows the running sample rate.
- **Interface language and theme** — the globe and theme buttons in the top bar; both persist. The theme button cycles dark → dim → light — dim is the default — and `?theme=dark` / `?theme=dim` / `?theme=light` in the URL forces one.
- **Deep links** — `index.html?load=<url>` opens a `.taud` from a URL, and `player.html` is a minimal stand-alone player.
- **Everything is local.** Clearing the browser's site data deletes your OPFS projects — export `.taud` files of anything you care about.

## About

Microtone is free software, distributed under the terms of the GNU General Public License
version 3. Source, issues and discussion:
[github.com/curioustorvald/Microtone.js](https://github.com/curioustorvald/Microtone.js)
— you can support development via
[Ko-fi](https://ko-fi.com/curioustorvald), [PayPal](https://paypal.me/curioustorvald) or
[GitHub Sponsors](https://github.com/sponsors/curioustorvald).
