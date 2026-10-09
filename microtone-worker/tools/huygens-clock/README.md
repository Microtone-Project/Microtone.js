# Huygens' Clock — the demo song's generator

The demo song `assets/demo_projects/Huygens_clock.taud` is **generated procedurally** by these scripts. Every note, the instrument bank, the zone re-tuning, the mix and the mastering chain are computed here, so the `.taud` is a generated artefact: change the scripts and rebuild, never edit the file by hand. A hand edit is lost the next time anyone rebuilds it, and the next rebuild is how every other change reaches it.

From `microtone-worker/` (needs `python3`, which runs the app's own SoundFont driver):

    node tools/huygens-clock/make.mjs

Then update the song's `bytes` in `assets/demo_projects/demos.json` and re-record its golden digests with `node tools/make-golden.js Huygens_clock`. The build is deterministic: the same sources and the same bundled soundfont give the same file, byte for byte.

| File | Contents |
|---|---|
| `song.mjs` | The notes: harmony, every part, section by section |
| `lib.mjs` | 31-EDO pitch arithmetic, per-lane events, melody strings, chord voicing, and the compiler from events to patterns and cues |
| `meta.mjs` | The bank's presets, tempo, mix and mastering settings, title, credits and the Project message |
| `zonetune.mjs`, `retune.mjs` | Measure where each SoundFont zone the song plays really sounds, and re-tune it onto the 31-TET grid |
| `make.mjs` | SoundFont → bank → composition → zone pruning → re-tuning → save |

The bank is built from `assets/GeneralUser-GS.taud.sf2.gz`, the soundfont the app bundles, so a change to that file changes the song too. The re-tuning makes up for GeneralUser's own sample tuning — a few cents either way, about 8 on the pad — which is nothing in twelve-tone music and a fifth of a step in 31-TET.

Pitches are written as 31-EDO steps from C0, or as names in the Timeline's 31-TET spelling with the octave digit as the period (`Cp4` is degree 30 of period 4, just below C5). A melody string is a run of `NAME:LENGTH` tokens in rows, two rows to the eighth; `~` glides into a note, `v` adds vibrato, `@n` sets its volume, `r` is a rest and `|` checks a bar line.
