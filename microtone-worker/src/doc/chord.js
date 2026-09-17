// Chord maker (item 89) — build a CHORDED sample by mixing pitch-shifted
// copies of an existing one, the old Amiga trick: one Paula channel can only
// play one sample, so trackers baked the chord into the sample itself.
//
// Pure float-domain computation (no DOM, Node-tested). Everything funnels
// through ONE canonical quantity: a note's pitch offset in 4096-TET units
// (0x1000 = octave), the project's native pitch unit. The three "mods" of the
// TODO are just three ways of naming that offset —
//   ji     a named just ratio (always available, tuning-independent)
//   key    N degrees of the CURRENT project notation (24-TET has more
//          options than 12-TET, by construction)
//   ratio  a raw playback ratio, 2.0 = an octave up   ┐ the two manual
//   units  a raw 4096-TET offset, e.g. 0x100          ┘ input styles
// — plus a per-note `oct` (×2^n) that every mode shares, so voicing a chord
// never means hunting through the interval list for "a fifth, two octaves up".
// Modes are per note: note 1 can be a just fifth while note 2 counts
// degrees and note 3 types a ratio.
//
// Playback ratio r = 2^(units/4096); a copy pitched up by r plays r× faster,
// i.e. resample(buf, 1/r) — which also anti-aliases on the way up, since the
// Kaiser-sinc cutoff follows the ratio (wavelab.js).

import { MIDDLE_C } from "../engine/constants.js";
import { resample, normaliseRange } from "./wavelab.js";

export const UNITS_PER_OCTAVE = 0x1000;
export const MAX_VOICES = 6;
/** Pitch travel a note may ask for, either way. Four octaves up already means
 *  a 16× oversized working buffer when a note also runs four octaves down. */
export const MAX_UNITS = 4 * UNITS_PER_OCTAVE;

/**
 * Named just intervals, ascending within one octave. `id` is the stable key
 * (presets, saved state, tests); `key` is the i18n name. Anything outside the
 * octave is reached with the note's `oct` field rather than a longer list.
 */
export const JI_INTERVALS = [
  { id: "1/1",   num: 1,  den: 1,  key: "chord.ji.unison" },
  { id: "16/15", num: 16, den: 15, key: "chord.ji.min2" },
  { id: "9/8",   num: 9,  den: 8,  key: "chord.ji.maj2" },
  { id: "7/6",   num: 7,  den: 6,  key: "chord.ji.sep3" },
  { id: "6/5",   num: 6,  den: 5,  key: "chord.ji.min3" },
  { id: "5/4",   num: 5,  den: 4,  key: "chord.ji.maj3" },
  { id: "9/7",   num: 9,  den: 7,  key: "chord.ji.sepMaj3" },
  { id: "4/3",   num: 4,  den: 3,  key: "chord.ji.fourth" },
  { id: "11/8",  num: 11, den: 8,  key: "chord.ji.und4" },
  { id: "7/5",   num: 7,  den: 5,  key: "chord.ji.sepTt" },
  { id: "45/32", num: 45, den: 32, key: "chord.ji.aug4" },
  { id: "3/2",   num: 3,  den: 2,  key: "chord.ji.fifth" },
  { id: "8/5",   num: 8,  den: 5,  key: "chord.ji.min6" },
  { id: "5/3",   num: 5,  den: 3,  key: "chord.ji.maj6" },
  { id: "7/4",   num: 7,  den: 4,  key: "chord.ji.harm7" },
  { id: "16/9",  num: 16, den: 9,  key: "chord.ji.pyth7" },
  { id: "9/5",   num: 9,  den: 5,  key: "chord.ji.min7" },
  { id: "15/8",  num: 15, den: 8,  key: "chord.ji.maj7" },
  { id: "2/1",   num: 2,  den: 1,  key: "chord.ji.octave" },
];

export function jiById(id) {
  return JI_INTERVALS.find((iv) => iv.id === id) ?? JI_INTERVALS[0];
}

/** A single silent-by-default note slot. */
export function defaultVoice() {
  return { on: false, mode: "ji", ji: "1/1", step: 0, ratio: 1, units: 0, oct: 0, gainDb: 0 };
}

/** Six note slots seeded with `preset`'s notes (a chord-preset id). */
export function defaultVoices(presetId = "major") {
  return applyChordPreset(presetId);
}

/**
 * The order the preset menus group their entries in — one optgroup each, so a
 * vocabulary this size stays readable in a `<select>`.
 */
export const CHORD_GROUPS = ["triad", "seventh", "added", "extended", "spread",
  "neutral", "extraclassical", "tetrachord"];

// ── Tetrachords (item 141) ───────────────────────────────────────────────────
// A tetrachord is the ancient Greeks' unit of scale construction: four pitches
// spanning a perfect fourth, named by the three scalar steps between them
// ("3-3-1"), which always add up to the fourth. Every EDO divides the fourth
// its own way, so the vocabulary is per-tuning — these only appear when the
// project notation IS the tuning they belong to, since a 17edo tetrachord
// counted out in 12-TET degrees would be a different chord entirely.
//
// The step patterns are the complete charts from the Xenharmonic Wiki:
// "17edo tetrachords", "22edo tetrachords" and, for 31edo, "Tricesimoprimal
// Tetrachordal Tesseract" — every way of breaking the fourth into three steps
// (15, 28 and 66 of them). The names are the wiki's own; where it leaves a
// tetrachord unnamed, so do we, and the step pattern speaks for itself.
const TETRACHORD_TUNINGS = [
  { notation: 170, fourth: 7 },   // 17-TET
  { notation: 220, fourth: 9 },   // 22-TET
  { notation: 310, fourth: 13 },  // 31-TET
];

// Wiki names, by tuning and step pattern. 17edo's are maqam/mode names; 22edo's
// are the genus (the classical enharmonic/chromatic/diatonic split) plus the
// temperament each belongs to where the page names one. 31edo's chart is a bare
// enumeration — the tesseract is the point, not the naming.
//
// Where the wiki lists SEVERAL modes for one pattern we keep the first and drop
// the rest (4-4-1 is "Superpyth major", not "Superpyth major, mixolydian,
// lydian"): the step pattern is the real name, and a menu entry that runs past
// the width of the select squeezes everything beside it. The full mode lists
// are one click away in the source page.
const TETRACHORD_NAMES = {
  170: {
    "1-3-3": "phrygian (jins Kurd)",
    "1-5-1": "balkan, jins Hijaz",
    "2-2-3": "jins Bayyati",
    "2-3-2": "ʻIraq",
    "3-1-3": "aeolian (jins Nahawand)",
    "3-2-2": "jins Rast",
    "3-3-1": "ionian (jins ʻAjam)",
  },
  220: {
    "1-1-7": "enharmonic", "1-7-1": "enharmonic", "7-1-1": "enharmonic",
    "1-2-6": "chromatic", "2-1-6": "chromatic", "1-6-2": "chromatic",
    "2-6-1": "chromatic", "6-1-2": "chromatic", "6-2-1": "chromatic",
    "1-3-5": "chromatic", "3-1-5": "chromatic", "1-5-3": "chromatic",
    "3-5-1": "chromatic", "5-1-3": "chromatic", "5-3-1": "chromatic",
    "2-2-5": "chromatic", "2-5-2": "chromatic", "5-2-2": "chromatic",
    "2-3-4": "diatonic", "3-2-4": "diatonic", "2-4-3": "diatonic",
    "3-4-2": "diatonic", "4-2-3": "diatonic", "4-3-2": "diatonic",
    "1-4-4": "diatonic · Superpyth phrygian",
    "4-1-4": "diatonic · Superpyth minor",
    "4-4-1": "diatonic · Superpyth major",
    "3-3-3": "diatonic · Porcupine",
  },
  310: {},
};

/**
 * Every tetrachord of every supported tuning, as chord presets: four notes in
 * `key` mode standing on the unison, the two inner degrees and the fourth.
 * Ordered first step ascending, then middle step — the wiki charts' own layout,
 * which puts the primary tetrachords (one second and one third) in the middle.
 */
function buildTetrachords() {
  const out = [];
  for (const { notation, fourth } of TETRACHORD_TUNINGS) {
    for (let a = 1; a <= fourth - 2; a++) {
      for (let b = 1; b <= fourth - a - 1; b++) {
        const c = fourth - a - b;
        const steps = `${a}-${b}-${c}`;
        out.push({
          id: `tetra${notation}-${steps}`,
          group: "tetrachord",
          notation,
          steps,
          name: TETRACHORD_NAMES[notation][steps] ?? "",
          voices: [
            { mode: "key", step: 0 },
            { mode: "key", step: a },
            { mode: "key", step: a + b },
            { mode: "key", step: fourth },
          ],
        });
      }
    }
  }
  return out;
}

// ── Extraclassical harmony: arto and tendo (item 167) ────────────────────────
// Ultramajor ("tendo", T) and inframinor ("arto", r) triads are the ordinary
// major and minor shapes with the third pushed a further quarter tone OUT: an
// arto third of ~235-255 ¢ under the fifth, a tendo third of ~445-465 ¢ over
// the root. They behave like major and minor — tendo is the consonant one —
// but they are CROSS-TONAL: unlike a major and a minor third, which clash, an
// arto and a tendo third sit a whole tone apart and can sound together over
// one root (the 20:23:26:30 chord). Source: Xenharmonic Wiki "Arto and tendo /
// Extraclassical tonality", kept at
// tsvm/reference_materials/xenharmonics/Extraclassical tonality.mediawiki.
//
// The wiki gives TWO definitions, and they do not always pick the same pair:
//
//   LATITUDE — a third's position between root and fifth, measured as
//   (third/fifth − 1/2) × 180°, so 0° is dead centre (a neutral third) and
//   ±90° is the fifth itself. Major/minor sit around ±13°; arto/tendo are
//   ±24-28° canonically, ±22.5-30° by the wiki's own broadened table. This is
//   what makes the chord SOUND extraclassical, and it needs no notation at
//   all. Reproducing it over every EDO reproduces the wiki's tuning table
//   exactly (5, 10, 15, 16, 19, 24, 29, 31, 41, 53 … — and correctly finds
//   nothing in 17 or 22).
//
//   QUALITY ARITHMETIC — arto = semi-diminished, tendo = semi-augmented, i.e.
//   half a chroma under the minor/perfect interval and half a chroma over the
//   major/perfect one. It needs a diatonic EDO whose chroma is an EVEN number
//   of steps, and then it spells a whole LADDER (tendo unison … arto octave),
//   which is where the extended vocabulary below comes from. Only the halves
//   of the scale it can reach are extraclassical by ear, though: 17-TET's
//   quality thirds are at ±36° (its tendo third IS its perfect fourth, the
//   very collision the wiki warns about) and 31-TET's are at ±20°.
//
//   And one tuning gets in on neither, by the wiki's §Use cases: "in diatonic
//   edos sharper than, and even in, 22edo, the native diatonic major and minor
//   triads begin to border on arto and tendo". A superpyth fifth drags the
//   ORDINARY thirds outwards until they arrive of their own accord — 22-TET's
//   are 273 ¢ and 436 ¢, within 6 ¢ of 7/6 and 9/7, which is the first 7-limit
//   tuning the wiki lists for the pair (a closer fit than 31-TET's spelt one),
//   even though their latitude is only ±20.8° and the chroma is odd. The
//   cross-tonality then lives in the chromatic 5L7s MOS, which carries both
//   thirds over one root. Among our notations that criterion — a proper 5L2s
//   diatonic with a fifth at least as sharp as 22-TET's 709 ¢ — picks out
//   22-TET and nothing else.
//
// Where a tuning offers both readings we offer both, tagged with the just
// ratios each is closest to. 41-TET is the wiki's own headline case ("first
// tuning with 2 pairs"); 31-TET's two are its 7/6-9/7 spelling and its
// slendric 8/7-21/16 one; 96-TET, which the wiki's table stops short of, has
// three by the same arithmetic.
//
// EVERYTHING ELSE IS DERIVED, not tabulated — the pair plus the fifth is
// enough, because the ladder is closed under stacking and octave inversion:
//     arto/tendo seventh = fifth + arto/tendo third
//     tendo second = octave − arto seventh   arto second = octave − tendo 7th
//     tendo sixth  = octave − arto third     arto sixth  = octave − tendo 3rd
// Checked against every cell of the wiki's 17/24/31/41 table (see
// test/node/chord.test.js), which it reproduces but for three typos there:
// 31-TET's tendo fourth is 542 ¢ not 541, its arto fifth 658 ¢ not 659, and
// 41-TET's arto fifth 644 ¢ not 654 (654 ¢ is not even a degree of 41-TET).
// The altered fourths and fifths are the exception: they are half a chroma off
// a perfect interval, so only the quality tunings have them, and only those
// get the arto-diminished and tendo-augmented triads.
//
// NOT offered, and why: 12-TET (and the 12-note historical notations) is too
// coarse to place a third a quarter tone outside major, and its own thirds
// sit at ±12.9°, nowhere near far enough out to arrive there by themselves;
// 5- and 10-TET have a pair but too few degrees to voice it — every
// extraclassical chord there is just a slice of the pentatonic scale. Nor do
// we sweep for ANY well-tuned 7/6-9/7 or 8/7-21/16 pair a fine tuning happens
// to contain (53-TET has three such, 96-TET four): the wiki never does that,
// and three near-identical vocabularies 23 ¢ apart is a menu, not a choice.

/**
 * Per-tuning arto/tendo data. `fifth` and the pair degrees are counts of that
 * tuning's own steps; `half` is half a chroma where the tuning HAS one (the
 * quality ladder), null otherwise. `ji` names the pair for the menu and is
 * carried only by tunings with more than one — the just ratios each pair is
 * nearest, which is the wiki's own way of telling arto/tendo tunings apart.
 * Pairs are listed widest latitude first.
 */
const EXTRACLASSICAL_TUNINGS = [
  // notation   edo  fifth  half  pairs (arto third, tendo third)
  { notation: 150, edo: 15, fifth: 9,  half: null, pairs: [{ a: 3, t: 6 }] },
  { notation: 160, edo: 16, fifth: 9,  half: null, pairs: [{ a: 3, t: 6 }] },
  { notation: 170, edo: 17, fifth: 10, half: 1,    pairs: [{ a: 3, t: 7 }] },
  { notation: 190, edo: 19, fifth: 11, half: null, pairs: [{ a: 4, t: 7 }] },
  { notation: 220, edo: 22, fifth: 13, half: null, pairs: [{ a: 5, t: 8 }] },
  { notation: 240, edo: 24, fifth: 14, half: 1,    pairs: [{ a: 5, t: 9 }] },
  { notation: 310, edo: 31, fifth: 18, half: 1,    pairs: [
    { a: 6, t: 12, ji: "8/7·21/16" }, { a: 7, t: 11, ji: "7/6·9/7" }] },
  { notation: 410, edo: 41, fifth: 24, half: 2,    pairs: [
    { a: 8, t: 16, ji: "8/7·21/16" }, { a: 9, t: 15, ji: "7/6·9/7" }] },
  { notation: 530, edo: 53, fifth: 31, half: null, pairs: [{ a: 11, t: 20 }] },
  { notation: 531, edo: 53, fifth: 31, half: null, pairs: [{ a: 11, t: 20 }] },
  { notation: 960, edo: 96, fifth: 56, half: 4,    pairs: [
    { a: 19, t: 37, ji: "8/7·21/16" }, { a: 20, t: 36, ji: "15/13·13/10" },
    { a: 21, t: 35, ji: "7/6·9/7" }] },
];

/** The whole interval vocabulary a pair generates, in degrees of its tuning. */
function extraclassicalVocab(tuning, pair) {
  const { edo, fifth, half } = tuning;
  return {
    edo, p5: fifth, a3: pair.a, t3: pair.t,
    a7: fifth + pair.a, t7: fifth + pair.t,           // stack a third on the fifth
    t2: edo - (fifth + pair.a), a2: edo - (fifth + pair.t),   // …and invert it
    a6: edo - pair.t, t6: edo - pair.a,
    a5: half === null ? null : fifth - half,
    t5: half === null ? null : fifth + half,
    // A pair that trisects the fifth IS the slendric generator stacked (the
    // wiki's 3edf row), which is what makes the six-note chain equal-stepped.
    slendric: fifth % 3 === 0 && pair.a === fifth / 3,
  };
}

/**
 * The chord shapes, in menu order. Each returns degrees of the tuning, root
 * first, or null when the tuning cannot spell it. The classical chord each one
 * answers to is in the comment; the ninths count past the octave, which
 * degreeUnits wraps into the next period on its own.
 */
const EXTRACLASSICAL_SHAPES = [
  { id: "arto",       degrees: (v) => [0, v.a3, v.p5] },                    // minor
  { id: "tendo",      degrees: (v) => [0, v.t3, v.p5] },                    // major
  { id: "artodim",    degrees: (v) => (v.a5 === null ? null : [0, v.a3, v.a5]) },   // dim
  { id: "tendoaug",   degrees: (v) => (v.t5 === null ? null : [0, v.t3, v.t5]) },   // aug
  { id: "cross",      degrees: (v) => [0, v.a3, v.t3, v.p5] },              // 20:23:26:30
  { id: "arto7",      degrees: (v) => [0, v.a3, v.p5, v.a7] },              // m7
  { id: "tendo7",     degrees: (v) => [0, v.t3, v.p5, v.t7] },              // maj7
  { id: "tendodom7",  degrees: (v) => [0, v.t3, v.p5, v.a7] },              // dom7
  { id: "artotendo7", degrees: (v) => [0, v.a3, v.p5, v.t7] },              // mMaj7
  { id: "arto6",      degrees: (v) => [0, v.a3, v.p5, v.t6] },              // m6
  { id: "tendo6",     degrees: (v) => [0, v.t3, v.p5, v.t6] },              // 6
  { id: "artoadd9",   degrees: (v) => [0, v.a3, v.p5, v.edo + v.t2] },      // m(add9)
  { id: "tendoadd9",  degrees: (v) => [0, v.t3, v.p5, v.edo + v.t2] },      // add9
  { id: "arto9",      degrees: (v) => [0, v.a3, v.p5, v.a7, v.edo + v.t2] },   // m9
  { id: "tendo9",     degrees: (v) => [0, v.t3, v.p5, v.t7, v.edo + v.t2] },   // maj9
  { id: "cross7",     degrees: (v) => [0, v.a3, v.t3, v.p5, v.a7] },
  { id: "chain",      degrees: (v) => (v.slendric
    ? [0, v.a3, v.t3, v.p5, v.a7, v.t7] : null) },
];

/**
 * A degree-mode shape survives when it reads bottom to top with no two notes
 * on one degree and nothing landing on an octave of the root — which is how
 * the degenerate cases weed themselves out (both families use this). 15-TET's fifth is exactly 3\5 of the
 * octave, so its tendo seventh IS the octave and every chord that wants one
 * (including the slendric chain) drops; 17-TET, whose arto second is the
 * unison, loses the same chords from the other end.
 */
function degreeShapeUsable(degrees, edo) {
  if (degrees[0] !== 0) return false;
  for (let i = 1; i < degrees.length; i++) {
    if (degrees[i] <= degrees[i - 1]) return false;
    if (degrees[i] % edo === 0) return false;
  }
  return true;
}

/**
 * Every arto/tendo chord of every tuning that has one, as `key`-mode presets —
 * degrees, not ratios, which is exactly why they are tuning-locked. Two pairs
 * of one tuning can spell the same chord (41-TET's 8/7 sixth is its 7/6
 * seventh); the first one wins and the duplicate is dropped, so no tuning ever
 * offers the same set of pitches twice.
 */
function buildExtraclassical() {
  const out = [];
  for (const tuning of EXTRACLASSICAL_TUNINGS) {
    const seen = new Set();
    for (const pair of tuning.pairs) {
      const v = extraclassicalVocab(tuning, pair);
      for (const shape of EXTRACLASSICAL_SHAPES) {
        const degrees = shape.degrees(v);
        if (!degrees || !degreeShapeUsable(degrees, tuning.edo)) continue;
        const sig = degrees.join(",");
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({
          id: `xc${tuning.notation}-${pair.a}-${shape.id}`,
          group: "extraclassical",
          notation: tuning.notation,
          key: `chord.preset.xc.${shape.id}`,
          ...(tuning.pairs.length > 1 ? { variant: pair.ji } : {}),
          voices: degrees.map((d) => ({ mode: "key", step: d })),
        });
      }
    }
  }
  return out;
}

// ── Neutral harmony (item 167, follow-up) ────────────────────────────────────
// A neutral third is the CENTRE of the third category — "the point around
// which the qualities of that category are symmetric" — which in practice
// means exactly HALF THE FIFTH, latitude 0° in the arto/tendo geometry above.
// Its canonical tunings are sqrt(3/2) = 351 ¢ (literally half a just fifth),
// 11/9 = 347 ¢ and 16/13 = 359 ¢, and the wiki's band is ~341-361 ¢. Source:
// Xenharmonic Wiki "Neutral (interval quality)", kept at
// tsvm/reference_materials/xenharmonics/"Neutral (interval quality).mediawiki".
//
// Neutral is NOT extraclassical and gets its own menu group: arto and tendo
// sit OUTSIDE major and minor, neutral sits BETWEEN them. (The wiki keeps them
// apart too — its "tendoneutral" is a neutral quality, not the "tendo" above.)
//
// The same stack-and-invert algebra generates the rest of the ladder, with the
// pair collapsed to a single interval, and it lands on the wiki's own
// canonical values every time:
//     neutral seventh = fifth + neutral third   (24-TET: 1050 ¢ ≈ 11/6)
//     neutral sixth   = octave − neutral third  (24-TET:  850 ¢ ≈ 18/11)
//     neutral second  = octave − neutral 7th    (24-TET:  150 ¢ ≈ 12/11)
//
// WHICH TUNINGS: half the fifth has to land in the neutral band, and the
// tuning has to be able to SPELL that half. An even fifth (in steps) splits
// exactly; an odd one cannot, and the two degrees either side of the centre
// are precisely the wiki's ARTONEUTRAL (flat of centre, 11/9 territory) and
// TENDONEUTRAL (sharp of centre, 16/13) — offered only where the step is fine
// enough for both halves to still read as neutral, which among our notations
// means 53-TET (±11 ¢) and not 12-, 15-, 19- or 22-TET (±27 ¢ to ±50 ¢: their
// thirds are plain major and minor, which is the whole reason 12-TET has no
// neutral third). 16-TET is excluded from the other end — its fifth is so flat
// that half of it is 337 ¢, under the band — and 5-, 7- and 10-TET on the same
// grounds as the arto/tendo family, too few degrees to voice a chord with.
//
// The mixed sevenths are the one thing NOT derived: a neutral triad under the
// tuning's own minor or major seventh is the commonest neutral chord in
// practice, and those two sevenths are what the neutral seventh sits between,
// so the tuning's diatonic m7 (4L+2s) and M7 (5L+s) are carried here too.
const NEUTRAL_TUNINGS = [
  // notation   edo  fifth  m7  M7   neutral third(s); `ji` only where two
  { notation: 170, edo: 17, fifth: 10, m7: 14, M7: 16, thirds: [{ n: 5 }] },
  { notation: 240, edo: 24, fifth: 14, m7: 20, M7: 22, thirds: [{ n: 7 }] },
  { notation: 310, edo: 31, fifth: 18, m7: 26, M7: 28, thirds: [{ n: 9 }] },
  { notation: 410, edo: 41, fifth: 24, m7: 34, M7: 38, thirds: [{ n: 12 }] },
  { notation: 530, edo: 53, fifth: 31, m7: 44, M7: 49, thirds: [
    { n: 15, ji: "11/9" }, { n: 16, ji: "16/13" }] },
  { notation: 531, edo: 53, fifth: 31, m7: 44, M7: 49, thirds: [
    { n: 15, ji: "11/9" }, { n: 16, ji: "16/13" }] },
  { notation: 960, edo: 96, fifth: 56, m7: 80, M7: 88, thirds: [{ n: 28 }] },
];

/** What one neutral third generates, in degrees of its tuning. */
function neutralVocab(tuning, third) {
  const { edo, fifth } = tuning;
  return {
    edo, p5: fifth, m7: tuning.m7, M7: tuning.M7, n3: third.n,
    n7: fifth + third.n, n6: edo - third.n, n2: edo - (fifth + third.n),
  };
}

/**
 * Neutral chord shapes, in menu order — the same skeleton as the arto/tendo
 * list, with one third instead of two. The chain is the fifth halved twice
 * over: two neutral thirds to the fifth, two more to the fifth of the fifth
 * (and in 53-TET, where the fifth is an odd number of steps, "half" is the
 * artoneutral or tendoneutral third and the rungs are one step uneven).
 */
const NEUTRAL_SHAPES = [
  { id: "neutral",     degrees: (v) => [0, v.n3, v.p5] },
  { id: "neutral7",    degrees: (v) => [0, v.n3, v.p5, v.n7] },
  { id: "neutralmin7", degrees: (v) => [0, v.n3, v.p5, v.m7] },
  { id: "neutralmaj7", degrees: (v) => [0, v.n3, v.p5, v.M7] },
  { id: "neutral6",    degrees: (v) => [0, v.n3, v.p5, v.n6] },
  { id: "neutraladd9", degrees: (v) => [0, v.n3, v.p5, v.edo + v.n2] },
  { id: "neutral9",    degrees: (v) => [0, v.n3, v.p5, v.n7, v.edo + v.n2] },
  { id: "neutralchain", degrees: (v) => [0, v.n3, v.p5, v.n7, 2 * v.p5] },
];

/** Every neutral chord of every tuning that can spell a neutral third. */
function buildNeutral() {
  const out = [];
  for (const tuning of NEUTRAL_TUNINGS) {
    const seen = new Set();
    for (const third of tuning.thirds) {
      const v = neutralVocab(tuning, third);
      for (const shape of NEUTRAL_SHAPES) {
        const degrees = shape.degrees(v);
        if (!degrees || !degreeShapeUsable(degrees, tuning.edo)) continue;
        const sig = degrees.join(",");
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({
          id: `nt${tuning.notation}-${third.n}-${shape.id}`,
          group: "neutral",
          notation: tuning.notation,
          key: `chord.preset.nt.${shape.id}`,
          ...(tuning.thirds.length > 1 ? { variant: third.ji } : {}),
          voices: degrees.map((d) => ({ mode: "key", step: d })),
        });
      }
    }
  }
  return out;
}

/**
 * Ready-made voicings, all in `ji` mode except `detune` — which demonstrates
 * the manual ratio input, and is the other classic use of this tool (three
 * near-unison copies = a chorus/supersaw in one sample).
 *
 * Notes ABOVE the octave are the plain interval plus `oct: 1`: a ninth is the
 * major second an octave up, an eleventh the fourth, a thirteenth the sixth —
 * which is what those degrees mean, and it keeps JI_INTERVALS one octave long.
 * Notes are listed ASCENDING; nothing depends on it (inversions sort), but a
 * preset that reads bottom-to-top is a preset you can check by eye.
 *
 * Six slots is the ceiling, so the tall chords omit what a keyboard player
 * omits: the eleventh drops the third, the thirteenth drops the eleventh.
 */
export const CHORD_PRESETS = [
  // ── triads ──
  { id: "major",   group: "triad", key: "chord.preset.major",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }] },
  { id: "minor",   group: "triad", key: "chord.preset.minor",   voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }] },
  { id: "sus2",    group: "triad", key: "chord.preset.sus2",    voices: [{ ji: "1/1" }, { ji: "9/8" }, { ji: "3/2" }] },
  { id: "sus4",    group: "triad", key: "chord.preset.sus4",    voices: [{ ji: "1/1" }, { ji: "4/3" }, { ji: "3/2" }] },
  { id: "dim",     group: "triad", key: "chord.preset.dim",     voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "7/5" }] },
  { id: "aug",     group: "triad", key: "chord.preset.aug",     voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "8/5" }] },
  // ── sevenths ──
  { id: "maj7",    group: "seventh", key: "chord.preset.maj7",    voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "15/8" }] },
  { id: "dom7",    group: "seventh", key: "chord.preset.dom7",    voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "7/4" }] },
  { id: "min7",    group: "seventh", key: "chord.preset.min7",    voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "9/5" }] },
  { id: "minmaj7", group: "seventh", key: "chord.preset.minmaj7", voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "15/8" }] },
  { id: "halfdim", group: "seventh", key: "chord.preset.halfdim", voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "7/5" }, { ji: "9/5" }] },
  { id: "dim7",    group: "seventh", key: "chord.preset.dim7",    voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "7/5" }, { ji: "5/3" }] },
  { id: "sus7",    group: "seventh", key: "chord.preset.sus7",    voices: [{ ji: "1/1" }, { ji: "4/3" }, { ji: "3/2" }, { ji: "7/4" }] },
  // ── sixths and added notes ──
  { id: "maj6",    group: "added", key: "chord.preset.maj6",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "5/3" }] },
  { id: "min6",    group: "added", key: "chord.preset.min6",   voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "5/3" }] },
  { id: "add9",    group: "added", key: "chord.preset.add9",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "9/8", oct: 1 }] },
  { id: "madd9",   group: "added", key: "chord.preset.madd9",  voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "9/8", oct: 1 }] },
  { id: "add11",   group: "added", key: "chord.preset.add11",  voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "4/3", oct: 1 }] },
  { id: "six9",    group: "added", key: "chord.preset.six9",   voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "5/3" }, { ji: "9/8", oct: 1 }] },
  // ── extended ──
  { id: "maj9",    group: "extended", key: "chord.preset.maj9",  voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "15/8" }, { ji: "9/8", oct: 1 }] },
  { id: "dom9",    group: "extended", key: "chord.preset.dom9",  voices: [{ ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "7/4" }, { ji: "9/8", oct: 1 }] },
  { id: "min9",    group: "extended", key: "chord.preset.min9",  voices: [{ ji: "1/1" }, { ji: "6/5" }, { ji: "3/2" }, { ji: "9/5" }, { ji: "9/8", oct: 1 }] },
  { id: "dom11",   group: "extended", key: "chord.preset.dom11", voices: [{ ji: "1/1" }, { ji: "3/2" }, { ji: "7/4" }, { ji: "9/8", oct: 1 }, { ji: "4/3", oct: 1 }] },
  { id: "dom13",   group: "extended", key: "chord.preset.dom13", voices: [
    { ji: "1/1" }, { ji: "5/4" }, { ji: "3/2" }, { ji: "7/4" }, { ji: "9/8", oct: 1 }, { ji: "5/3", oct: 1 },
  ] },
  // ── spreads: no third to speak of, so no quality either ──
  { id: "power",   group: "spread", key: "chord.preset.power",   voices: [{ ji: "1/1" }, { ji: "3/2" }, { ji: "1/1", oct: 1 }] },
  { id: "quartal", group: "spread", key: "chord.preset.quartal", voices: [{ ji: "1/1" }, { ji: "4/3" }, { ji: "16/9" }] },
  { id: "octaves", group: "spread", key: "chord.preset.octaves", voices: [{ ji: "1/1", oct: -1 }, { ji: "1/1" }, { ji: "1/1", oct: 1 }] },
  { id: "detune",  group: "spread", key: "chord.preset.detune",  voices: [
    { mode: "ratio", ratio: 0.994 }, { mode: "ratio", ratio: 1 }, { mode: "ratio", ratio: 1.006 },
  ] },
  // ── neutral, arto/tendo and tetrachords: one group per tuning, and only
  //    its own tuning sees any of them (items 167, 141) ──
  ...buildNeutral(),
  ...buildExtraclassical(),
  ...buildTetrachords(),
];

/**
 * The presets offered for a project in `pitchPreset`'s notation: everything
 * tuning-independent, plus the tetrachords of THIS tuning. A preset with no
 * `notation` field is always on the menu.
 */
export function chordPresetsFor(pitchPreset) {
  const index = pitchPreset?.index ?? -1;
  return CHORD_PRESETS.filter((p) => p.notation === undefined || p.notation === index);
}

/**
 * A preset's menu label. Named chords are an i18n lookup (pass `t`); a
 * tetrachord is its step pattern, followed by what the source calls it when
 * the source calls it anything — the pattern IS the name in that literature.
 * An arto/tendo chord carries its pair's just ratios where its tuning has more
 * than one pair, since the name alone would then name two different chords.
 */
export function chordPresetLabel(preset, translate) {
  if (!preset) return "";
  if (preset.steps) return preset.name ? `${preset.steps} · ${preset.name}` : preset.steps;
  const name = translate(preset.key);
  return preset.variant ? `${name} · ${preset.variant}` : name;
}

/** The preset entry for an id, or null — an unknown id is silence, not a throw. */
export function chordPresetById(presetId) {
  return CHORD_PRESETS.find((p) => p.id === presetId) ?? null;
}

/** How many notes a preset sounds — the inversion selector's ceiling. */
export function presetVoiceCount(presetId) {
  return chordPresetById(presetId)?.voices.length ?? 0;
}

/**
 * Highest inversion a preset has: the Nth lifts N notes, and lifting them all
 * is just the same chord an octave up.
 *
 * A tetrachord has none. It is a SCALE SEGMENT rather than a voicing — the
 * order of its degrees is the whole point of it — and its notes are counted in
 * degrees of one tuning, which the notation-independent ranking below cannot
 * weigh against an octave (invertVoiceSpecs).
 */
export function maxInversion(presetId) {
  if (chordPresetById(presetId)?.steps) return 0;
  return Math.max(0, presetVoiceCount(presetId) - 1);
}

/**
 * A note list inverted, in the textbook sense: the Nth inversion lifts the N
 * lowest notes an octave each, over the top of the chord, so it keeps its
 * notes and changes which one is in the bass. Out-of-range values are clamped
 * rather than wrapped (a "6th inversion" of a triad is not a thing).
 *
 * Ordering is by sounding pitch. The tuning-independent presets are written in
 * `ji`/`ratio` mode, so the bass note is the same one in every tuning and no
 * pitch table is needed; a `key`-mode preset (arto/tendo) DOES need one, since
 * a bare degree count cannot be weighed against an octave lift of 4096 units —
 * without it such a chord stays in root position rather than come out
 * scrambled. The result is re-sorted, which is what keeps the note rows
 * reading bottom-to-top after the lift.
 *
 * A chord that already contains its own octave (power, octaves) would land the
 * lifted note exactly on one it already has — a second copy of the same sample
 * at the same pitch, which is a level change and nothing else — so the lift
 * carries on up until the note is its own note again.
 */
export function invertVoiceSpecs(specs, inversion = 0, pitchPreset = null) {
  const n = Math.min(Math.max(Math.round(inversion) || 0, 0), Math.max(0, specs.length - 1));
  if (n === 0) return specs.slice();
  if (!pitchPreset && specs.some((s) => s.mode === "key")) return specs.slice();
  const ranked = specs
    .map((spec) => ({ spec, u: voiceUnits({ ...defaultVoice(), ...spec }, pitchPreset) }))
    .sort((a, b) => a.u - b.u);
  const taken = (u, self) => ranked.some((e, j) => j !== self && Math.abs(e.u - u) < 1);
  for (let i = 0; i < n; i++) {
    let octs = 1;
    while (octs < 4 && taken(ranked[i].u + octs * UNITS_PER_OCTAVE, i)) octs++;
    ranked[i] = {
      spec: { ...ranked[i].spec, oct: (ranked[i].spec.oct ?? 0) + octs },
      u: ranked[i].u + octs * UNITS_PER_OCTAVE,
    };
  }
  ranked.sort((a, b) => a.u - b.u);
  return ranked.map((e) => e.spec);
}

/** Six note slots for a chord-preset id, in its `inversion`th inversion;
 *  unused slots stay off. `pitchPreset` is the song's notation, which only a
 *  degree-mode preset needs, and only to invert (see invertVoiceSpecs). */
export function applyChordPreset(presetId, inversion = 0, pitchPreset = null) {
  const preset = chordPresetById(presetId);
  const specs = preset
    ? invertVoiceSpecs(preset.voices, maxInversion(presetId) === 0 ? 0 : inversion, pitchPreset)
    : [];
  const out = [];
  for (let i = 0; i < MAX_VOICES; i++) {
    const spec = specs[i];
    out.push(spec ? { ...defaultVoice(), on: true, ...spec } : defaultVoice());
  }
  return out;
}

/**
 * Pitch offset, in 4096-TET units, of `d` degrees of `preset`'s pitch table
 * counted from unison (degree 0 = the table entry at Middle C).
 *
 * Kept local rather than reaching for pitchtables.stepNoteInTable: doc/ must
 * not import from ui/, and a chord note steps by a WHOLE offset in one go
 * (walking one degree at a time would be the same arithmetic, slower).
 *   - lattice preset  degrees wrap into periods, so 13 degrees of 12-TET is an
 *                     octave + a semitone (and 14 of Bohlen-Pierce a tritave +
 *                     one step — periods are not assumed to be octaves);
 *   - absolute preset (interval 0, e.g. ProTracker) the table IS the complete
 *                     note list, so degrees clamp at its ends instead;
 *   - empty table     (Raw) one degree = one raw 4096-TET unit, matching what
 *                     the transpose dialogs do with no notation to lean on.
 */
export function degreeUnits(preset, d) {
  const table = preset?.table ?? [];
  d = Math.round(d) || 0;
  if (table.length === 0) return d;
  if (!preset.interval) {
    const base = preset.base ?? MIDDLE_C;
    let i0 = 0, bestD = Infinity;
    for (let i = 0; i < table.length; i++) {
      const dist = Math.abs(base + table[i] - MIDDLE_C);
      if (dist < bestD) { bestD = dist; i0 = i; }
    }
    const i = Math.min(Math.max(i0 + d, 0), table.length - 1);
    return base + table[i] - MIDDLE_C;
  }
  const n = table.length;
  const k = Math.floor(d / n);
  return k * preset.interval + table[d - k * n];
}

/** A note's total pitch offset in 4096-TET units (clamped to ±MAX_UNITS). */
export function voiceUnits(voice, preset) {
  if (!voice) return 0;
  let u = (Math.round(voice.oct ?? 0) || 0) * UNITS_PER_OCTAVE;
  switch (voice.mode) {
    case "key":
      u += degreeUnits(preset, voice.step ?? 0);
      break;
    case "ratio": {
      const r = Number(voice.ratio);
      u += Number.isFinite(r) && r > 0 ? UNITS_PER_OCTAVE * Math.log2(r) : 0;
      break;
    }
    case "units": {
      const v = Number(voice.units);
      u += Number.isFinite(v) ? v : 0;
      break;
    }
    default: {
      const iv = jiById(voice.ji);
      u += UNITS_PER_OCTAVE * Math.log2(iv.num / iv.den);
    }
  }
  return Math.min(Math.max(u, -MAX_UNITS), MAX_UNITS);
}

/** Playback ratio of a note (2.0 = an octave up). */
export function voiceRatio(voice, preset) {
  return Math.pow(2, voiceUnits(voice, preset) / UNITS_PER_OCTAVE);
}

/** Note word a note sounds when the root sounds Middle C — what the UI paints
 *  through the ordinary note-cell glyph painter, so the reading is the same one
 *  the pattern grid gives. */
export function voiceNote(voice, preset) {
  return Math.min(Math.max(Math.round(MIDDLE_C + voiceUnits(voice, preset)), 0x20), 0xffff);
}

export const activeVoices = (voices) => (voices ?? []).filter((v) => v && v.on !== false);

/**
 * Frames the mix will occupy, without building it. `lengthMode`:
 *   "longest"  the slowest (lowest) note sets the length — a one-shot keeps
 *              its whole tail whatever the chord does to it;
 *   "source"   the source length, cropping the low notes — what you want when
 *              the result is going to be looped, or fed back into a sampler
 *              slot whose length matters;
 *   "shortest" the FASTEST (highest) note sets it, cropping every other note
 *              back to where that one runs out. Nothing plays on alone, so the
 *              chord holds its full stack for every frame it has — which is
 *              what a loop wants, and what keeps a decaying source from
 *              thinning into its bass notes at the end.
 */
export function chordLength(srcLen, voices, preset, lengthMode = "longest") {
  if (lengthMode === "source") return srcLen;
  const lens = activeVoices(voices)
    .map((v) => Math.max(1, Math.floor(srcLen / voiceRatio(v, preset))));
  if (lens.length === 0) return srcLen;
  return lengthMode === "shortest" ? Math.min(...lens) : Math.max(...lens);
}

const dbToLin = (db) => Math.pow(10, (Number(db) || 0) / 20);

/**
 * Mix the chord. Returns {data, peak, voices} where `peak` is the mix's peak
 * BEFORE any normalisation (the UI reports it as headroom: six copies at unity
 * clip long before the 8-bit quantiser sees them) and `voices` is how many
 * sounded. `normalise` scales the result to full scale afterwards, which is
 * the sane default — the pool format is 8-bit and every dB counts.
 */
export function buildChord(buf, voices, preset, { normalise = true, lengthMode = "longest" } = {}) {
  const active = activeVoices(voices);
  const outLen = active.length === 0
    ? 0
    : Math.max(1, Math.min(chordLength(buf.length, active, preset, lengthMode), 1 << 24));
  const out = new Float32Array(outLen);
  for (const v of active) {
    const r = voiceRatio(v, preset);
    const part = Math.abs(r - 1) < 1e-9 ? buf : resample(buf, 1 / r);
    const gain = dbToLin(v.gainDb);
    const n = Math.min(outLen, part.length);
    for (let i = 0; i < n; i++) out[i] += part[i] * gain;
  }
  let peak = 0;
  for (let i = 0; i < outLen; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  return {
    data: normalise && peak > 0 ? normaliseRange(out, 0, outLen) : out,
    peak,
    voices: active.length,
  };
}
