# Promo director

A page that plays the tracker for a screen recorder. It loads Microtone with a
song, and when you press **Start** it gives a sync cue, presses Play, tours the
views in time with the music (with a drawn cursor, captions about the app, and
the address in the corner), and ends on a card with the address. You record it
with OBS and cut it with `cut.py`. No video editor is needed.

The first scene is **Eighth Baffling Incongruity Theorem** (`eighth.js`), built
from `OoT_musical_experiments/eight-bit/Eighth.tml`. It is only something of
our own to play: the captions describe the app, not the music. The take is 2 s of lead-in,
2:30 of song and 7 s of end card.

Nothing here ships. The page reaches the app the way the browser smokes do,
through `window.__microtone` and `click()` on the app's own buttons. The app
does not know it is being driven.

## Recording a take

1. **Build the song and serve the repo** from a port of its own:

       cd tools/promo
       make serve        # builds build/Eighth.taud, serves the repo root on :8950

   The build renames the song (not the project) to "Eighth" (`retitle.mjs`),
   so the song picker in the top bar stays short.

   A fresh port is a fresh origin, so it has no saved projects and no
   autosave-recovery dialog to appear in the middle of a take. Any server at
   the repo root that sends the COOP/COEP headers will do, including the
   `test-server.py` you may already run on :8932.

2. **Open** `http://127.0.0.1:8950/tools/promo/` and put the browser in full
   screen (F11), *then* reload: the stage is sized once, when the page loads.
   It is the largest 16:9 area that leaves room for the control strip, at most
   1920×1080 CSS px. Force a size with `?stage=1600x900`. The strip lists
   checks that should all be green, and gives the stage's size in screen
   pixels.

3. **Set up OBS**: a Window Capture (or Screen Capture) of the browser,
   cropped to the stage, which is the page's top-left `W×H` (in full screen,
   the screen's top-left corner). Set the canvas and output to that size,
   30 or 60 fps, with desktop audio. The cursor may stay captured: while a take
   runs, the real one is hidden over the stage, and only the drawn one is seen.

4. **Record**, then press **Start ▶** in the strip, beside the stage.

   - Until then the stage shows a grey STANDBY slate framed in amber, with
     corner marks: crop OBS to that frame.
   - The take opens with a **white frame and a 1 kHz beep**, then cuts
     straight to the title card. The cursor presses Play about 2 s after the flash.
   - At the end the strip turns red and says **Stop the recording**. The end
     card stays still until you do. **Esc** or **Abort** stops a take early.

5. **Cut**: the strip shows the command with the take's length filled in.

       python3 tools/promo/cut.py ~/Videos/recording.mkv --to 159.56 --out promo.mp4

   It finds the flash and the beep, moves the sound back in line with the
   picture if the recorder put them apart, and keeps the take from 0.25 s
   after the flash (on the title card, past the beep) to the end of the end
   card. It fades in and out and writes H.264 + AAC with `+faststart`.
   `--crop W:H:X:Y` crops as well, for when OBS did not. `--dry-run` only
   reports what it found.

**Rehearse** a passage by setting *Start at bar* first. A rehearsal skips the
intro and the sync cue and plays from that bar. Every take begins by putting the
app back to where the scene expects it: Timeline, full cells, Follow on.
Afterwards the page restores the app's saved preferences (theme, language, cell
width, recent files), so a take leaves your own set-up as it was.

## Editing the scene

`eighth.js` is the choreography, and you can change it without touching the
director:

- `intro(d)` runs from the flash to Play.
- `events` are keyed to **bars of the song**, 1-based and fractional (`17.5` is
  half-way through bar 17). Each event runs when the playhead reaches it, and
  the next one waits for it to finish.
- `outro(d)` runs after the last note.
- `sections` (`[name, firstBar, lastBar]`, optional) add a section name to the
  tag in the lower right corner. Without them, the tag shows only `site`.

The director (`d`) offers:

| Call | Does |
|---|---|
| `d.click(target)` | glide the cursor there, then click (`target`: a selector, an element, or `(d) => element`) |
| `d.point(target)` | glide there without clicking |
| `d.tab("instruments")` | click one of the app's view tabs |
| `d.caption(text \| [line, small line], { bars \| ms })` | the lower-third caption; it goes after `bars` of the song |
| `d.ring(target, { ms, label })` | a ring around an element, or around several (`(d) => [els]`), that follows them as they scroll |
| `d.scroll(target, top, ms)` | scroll an element of the app smoothly |
| `d.card({ wordmark, kicker, title, sub, lines, foot }, { full })` / `d.hideCard()` | the title or end card |
| `d.wait(ms)`, `d.at(seconds after flash)`, `d.untilBar(bar)` | waiting |
| `d.app`, `d.store`, `d.$(sel)`, `d.$$(sel)` | the app itself (`window.__microtone`), and queries in its document |

A new song is a new scene module: `?scene=name` loads `name.js` beside the
page. Captions are public text, so follow the docs' wording rules: a part of a
song is a *lane*, and effects are written as the manual writes them.
