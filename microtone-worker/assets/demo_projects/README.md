# Demo projects

The songs the app offers from the welcome screen ("Demo songs") and the File
tab ("Demo songs…"). `demos.json` is the list — dropping a `.taud` in here and
adding a row is all it takes to ship another one.

**These files are NOT covered by the GPL that covers the rest of this
repository.** Each is included by the permission of its copyright holder, on
the terms recorded below, and each keeps its own copyright. Redistributing
Microtone with a demo removed is always fine; redistributing a demo on other
terms is not.

`demos.json` repeats what the container already stores (title, composer, song
count, byte size) because the panel has to draw the entry *before* half a
megabyte is fetched. `test/node/demos.test.js` parses every listed file and
fails if the manifest and the container ever disagree, so the copy cannot rot.

## WHEN_AMBI.taud — "When the heavens fall"

- **Composer:** Jonne Valtonen, as *Purple Motion* (Future Crew)
- **Original:** `WHEN.S3M`, 1994
- **This rendition:** ambisonic Taud arrangement, © 2026 CuriousTorvald
- **Permission:** granted by the composer, 2026, in these terms — *"as long as
  the tracker is free, so is the demo song."*

Because the grant is conditional on Microtone staying *software gratis*, a fork or
a repackaging that is **not** *software gratis* must remove this file. The
arranger's note on the piece travels with it, in the project's Message
(`PMsg`) — open the Project tab after loading it.

## Huygens_clock.taud — "Huygens' Clock"

- **Built by Motif:** every note, the instrument bank, the zone re-tuning, the
  mix and the mastering chain are computed by the Taud Motif Language program
  `Huygens_clock.tml` beside it, written by Claude in 2026 (first as a
  JavaScript generator, whose output the program rebuilds byte for byte). This
  file is the program's output, and carries the program in its `PMtf` section:
  rebuild it with `node tools/motif.js assets/demo_projects/Huygens_clock.tml`
  (from `microtone-worker/`, needs python3), or with Build in the Motif view.
  It is a generated artefact: change the program and rebuild rather than
  editing the file by hand.
- **Instruments:** General MIDI patches from GeneralUser GS by S. Christian
  Collins, the soundfont Microtone bundles.
- **Copyright line in the project:** (c) 2026 CuriousTorvald.

The note on how the piece is built travels with it, in the project's Message
(`PMsg`) — open the Project tab after loading it.
