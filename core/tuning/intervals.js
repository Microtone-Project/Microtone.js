// A tuning's own intervals, counted in its own degrees — what an isomorphic
// keyboard is built from. Shared by Microtone Touch's hexagonal board
// (microtone-touch-worker/src/lattice.js) and the tracker's QWERTY keymaps
// (microtone-worker/src/ui/keymap.js), so a layout called Wicki–Hayden is the
// same intervals in both apps.
//
// The sizes are not tables per tuning. On an octave-period equal tuning they
// are derived from its own PATENT FIFTH — the nearest degree to 3/2 — along
// the chain of fifths, so "a whole tone" means two fifths less an octave on 12,
// 19, 31 or 53 tones alike. The major third is the chain's own, two whole
// tones, rather than the nearest degree to 5/4: the two agree up to 31-TET and
// part by a degree on 41- and 53-TET, where the chain's is the Pythagorean
// 81/64. A tuning whose period is not the octave (Bohlen–Pierce repeats at the
// tritave) has no chain of fifths to derive from, so there each interval is
// simply rounded to the nearest degree.
//
// Pure — no DOM, no state.

const OCTAVE = 0x1000; // the period of an octave tuning, in 4096-TET units
const cents = (ratio) => 1200 * Math.log2(ratio);

/**
 * Interval sizes, in degrees, of an `n`-degree tuning whose period is
 * `period` 4096-TET units (default: the octave).
 */
export function edoSteps(n, period = OCTAVE) {
  if (period === OCTAVE) {
    const fifth = Math.round(n * Math.log2(1.5));
    const tone = 2 * fifth - n;           // two fifths less an octave
    const limma = 3 * n - 5 * fifth;      // the diatonic semitone, E–F
    const apotome = tone - limma;         // the chromatic semitone, F–F♯
    const major3 = 2 * tone;
    const minor3 = fifth - major3;
    return { n, fifth, tone, limma, apotome, major3, minor3 };
  }
  const step = (period * 1200) / 4096 / n; // cents per degree
  const near = (ratio) => Math.round(cents(ratio) / step);
  return {
    n,
    fifth: near(3 / 2),
    tone: near(9 / 8),
    limma: near(256 / 243),
    apotome: near(2187 / 2048),
    major3: near(5 / 4),
    minor3: near(6 / 5),
  };
}
