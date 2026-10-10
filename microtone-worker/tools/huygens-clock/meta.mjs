// Song-level settings and texts for "Huygens' Clock".

export const TITLE = "Huygens' Clock";
export const FILE = "Huygens_clock.taud";

/** The bank, as [SF2 bank, program] from GeneralUser GS, in slot order: slot 1 is
 *  the first entry. song.mjs names the slots; changing this list renumbers them. */
export const PRESETS = [
  [128, 0],  // 1  Standard 1 (drum kit)
  [0, 35],   // 2  Fretless Bass
  [0, 4],    // 3  Tine Electric Piano
  [0, 12],   // 4  Marimba
  [0, 89],   // 5  Warm Pad
  [0, 49],   // 6  Slow Strings
  [13, 81],  // 7  Saw Lead 3
  [0, 73],   // 8  Flute
  [0, 27],   // 9  Clean Guitar
  [0, 11],   // 10 Vibraphone
];
export const COMPOSER = "Procedurally generated";
export const COPYRIGHT = "(c) 2026 CuriousTorvald";
export const BPM = 120;
export const GLOBAL_VOLUME = 255;
export const MIXING_VOLUME = 100;
export const INST_NAMES = { 1: "Standard Kit" };
/** Every layer's mix octet (§7.5's decibel octets, $9F = unity), per metainstrument
 *  slot: the tines up 3 dB ($B7), the strings down 3 dB ($87). */
export const LAYER_MIX = { 3: 0xb7, 6: 0x87 };
// trim → high-pass → EQ → compressor → width → limiter. The EQ lifts the lows
// and the top towards the other demos' tonal balance (octave-band LTAS).
export const MASTER = {
  on: true,
  trimDb: -2,
  hpOn: true, hpFreq: 25, hpSlope: 0,
  eqOn: true,
  eq: [
    { on: true, type: 0, freq: 100, gainDb: 3, q: 0.707 },
    { on: true, type: 1, freq: 320, gainDb: -1.5, q: 0.9 },
    { on: true, type: 1, freq: 3000, gainDb: 1.5, q: 0.8 },
    { on: true, type: 2, freq: 7000, gainDb: 3, q: 0.707 },
  ],
  compOn: true, compDetector: 1, compThreshDb: -20, compRatio: 2,
  compAttackMs: 25, compReleaseMs: 220, compKneeDb: 6, compMakeupDb: 5.84,
  widthOn: true, width: 1.3,
  limOn: true, limTruePeak: false, limCeilingDb: -0.2, limReleaseMs: 20,
  outGainDb: 0,
};
export const MESSAGE = "Huygens' Clock is a contemporary instrumental in 31-tone equal temperament and 7/8 time: sixty-four bars, every one counted 2+2+3. It is generated procedurally, by a script that is part of Microtone's source code, to show what the 31-TET grid can do; the last paragraph of this note says where to find it.\n\nThe title is two inventions of one man. Christiaan Huygens built the first pendulum clock in 1656, and in 1691 he proposed dividing the octave into 31 equal steps. The marimba figure that opens the piece and closes it is the clock, fourteen sixteenths to the bar, ticking in sevens. Everything else is the tuning.\n\nA step of 31-TET is 38.7 cents, a little less than a quarter tone. Its major third is within a cent of the pure 5/4, and its harmonic seventh within about a cent of 7/4, the seventh that barbershop singers lean into and a piano cannot play. Between the minor and the major third it has a neutral third (close to 11/9), and outside them a subminor (7/6) and a supermajor (9/7) third. The piece is built from exactly those.\n\nBars 1–8: the clock alone, then the band arriving.\n\nBars 9–16: the theme, on a septimal blues pentatonic: D, F half-flat (7/6), G, A, C half-flat (7/4). The tonic chord is 12:14:18:21. The dominant and the chord before it are both harmonic seventh chords (4:5:6:7); in 31-TET a German sixth is exactly that chord, which is why the turnaround slides home so smoothly.\n\nBars 17–24: a synth solo over the same loop. Listen for bends of a single step.\n\nBars 25–40: major chords climbing by neutral thirds: B flat, D half-flat, F, A half-flat, C, E half-flat, G, B half-flat. Two neutral thirds make a perfect fifth, so every other chord lands on the circle of fifths and the ones between sit exactly halfway. Two notes of each chord move by a single step and the third by a neutral second; the pad and the strings glide into each chord instead of striking it, and the flute's long notes bend by one step as the harmony turns under them.\n\nBars 41–48: over a D pedal, the third climbs one step a bar through all five thirds 31-TET has (subminor, minor, neutral, major, supermajor), and then the harmonic series assembles itself: the seventh, the ninth, the eleventh.\n\nBars 49–56: the theme again, its third raised from 7/6 to 5/4, over a 4:5:6:7 tonic.\n\nBars 57–64: German sixth and dominant once more, then the harmonic series on D (4:5:6:7:9:11) while the clock runs down.\n\nEvery note sits on the 31-TET grid, and the Timeline is set to 31-TET notation, so the names you read are the notes you hear: D, Dt and Dp are D, D half-sharp and D half-flat. The beat bands are set for 7/8, a line every eighth and a bar every fourteen rows.\n\nThe instruments are General MIDI patches from the GeneralUser GS soundfont by S. Christian Collins, the one Microtone bundles. Its samples are tuned for twelve-tone music, a few cents either way, and up to eight on the pad: nothing in a piano, but a fifth of a step here. So the script measures where every zone the song plays really sounds and re-tunes it onto the 31-TET grid, to within about a cent. The corrections are ordinary per-zone detune: open the Instruments view to see them.\n\nThe master is Microtone's own chain, saved with the project: a 25 Hz high-pass, four bands of EQ, a 2:1 compressor, stereo width at 130% and a limiter holding −0.2 dB, for about −14 LUFS. Bypass it in the Mastering view to hear the mix underneath.\n\nNothing in this project was played or placed by hand. The notes, the instrument bank, the re-tuning, the mix and the master are all computed by the script in microtone-worker/tools/huygens-clock in Microtone's source code, and this project is its output: running it again rebuilds this file byte for byte. You can still open it and change it like any other project.";

