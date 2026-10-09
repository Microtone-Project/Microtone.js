// Microtone Touch's promo shots — microtone-touch-worker/screenshots/. Run by
// make-screenshots.js; the `stage` and `ready` functions run IN THE PAGE (they
// are sent over CDP as source), so they reach nothing here but their `arg`.
//
// A phone, 390×844 CSS px at 3× (1170×2532), held upright unless a shot says
// otherwise. Touch has no demo of its own, so the sketch every shot plays is
// written here: four bars over C7 – Am – F – G7 with harmonic sevenths, in
// cents, and retuned to each shot's tuning by the rule Temperament… itself
// uses (nearest degree), so it is the sketch a user would see after picking
// that tuning. It goes in as the saved working copy, with the preferences
// beside it, before the page loads.

import { fileURLToPath } from "node:url";
import { nearestDegreeIndex, noteForDegree, pitchTablePresets, ANCHOR_NOTE } from "../../core/tuning/pitchtables.js";
import { DRUMS } from "../../core/sketch/pack.js";
import { normaliseSketch, tuningById, NOTE_OFF, ROWS, SKETCH_VERSION } from "../../../microtone-touch-worker/src/sketch.js";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const OUT = "../../../microtone-touch-worker/screenshots/";

// ── the sketch ───────────────────────────────────────────────────────────────

/** A pitch in cents from C4, as a note word of `tuning` — the nearest degree,
 *  exactly as app.js's setTuning moves a note. */
function note(cents, tuning) {
  const to = pitchTablePresets[tuningById(tuning).notation];
  const { index, period } = nearestDegreeIndex(ANCHOR_NOTE + Math.round((cents * 4096) / 1200), to);
  return noteForDegree(4 + period, index, to);
}

const MAJ7 = [0, 386, 702, 969]; // the seventh is 7/4, not a tempered B♭
const MIN = [0, 316, 702];
const MAJ = [0, 386, 702];
const BARS = [
  { root: 0, tones: MAJ7 },    // C7
  { root: -316, tones: MIN },  // Am
  { root: -702, tones: MAJ },  // F
  { root: -498, tones: MAJ7 }, // G7
];
const drum = (id) => DRUMS.findIndex((d) => d.id === id);
const [KICK, SNARE, HAT, OPEN_HAT] = ["kick", "snare", "hatc", "hato"].map(drum);
const DRUM_NOTE = 0x5000; // what a pad writes (keyboard.js)

/** The lead, bar by bar: [row, cents from C4, effect?]. */
const LEAD = [
  [[0, 1902, "vibrato"], [8, 1586], [12, 2169, "slide"]],
  [[0, 2100, "vibrato"], [8, 2084], [12, 1786]],
  [[0, 2084, "vibrato"], [8, 2400], [12, 2604]],
  [[0, 2288], [4, 2604], [8, 2871, "vibrato"], [14, NOTE_OFF]],
];

/** Section A: all eight lanes. B drops the lead; C is the drums and bass. */
function sections(tuning) {
  const cell = (cents) => ({ n: note(cents, tuning) });
  const lanes = Array.from({ length: 8 }, () => new Array(ROWS).fill(null));
  BARS.forEach(({ root, tones }, bar) => {
    const at = (row) => bar * 16 + row;
    const tone = (i, octave = 0) => root + tones[i % tones.length] + 1200 * (octave + Math.floor(i / tones.length));
    // Piano: the chord broken in eighths.
    [0, 2, 1, 2, 0, 2, 1, 3].forEach((i, k) => { lanes[0][at(k * 2)] = cell(tone(i)); });
    // Bass: root, root, fifth, octave.
    [[0, 0], [6, 0], [8, 2], [12, 3]].forEach(([row, i]) => {
      lanes[1][at(row)] = cell(root - 2400 + (i === 3 ? 1200 : tones[i]));
    });
    // Drums: one hit a row, the lane being one voice.
    [[0, KICK], [2, HAT], [4, SNARE], [6, HAT], [8, KICK], [10, KICK], [12, SNARE], [14, OPEN_HAT]]
      .forEach(([row, d]) => { lanes[2][at(row)] = { n: DRUM_NOTE, d }; });
    // Pad, electric piano, organ: the chord held across the bar.
    lanes[3][at(0)] = cell(tone(1));
    lanes[6][at(0)] = cell(tone(0, -1));
    lanes[7][at(0)] = cell(tone(2, -1));
    // Pluck: the offbeats, an octave up.
    [3, 7, 11, 15].forEach((row, k) => { lanes[4][at(row)] = cell(tone(k + 1, 1)); });
    for (const [row, cents, fx] of LEAD[bar]) {
      lanes[5][at(row)] = cents === NOTE_OFF ? { n: NOTE_OFF } : { ...cell(cents), ...(fx ? { fx, lv: 1 } : {}) };
    }
  });
  const only = (keep) => ({ cells: lanes.map((l, i) => (keep.includes(i) ? l : new Array(ROWS).fill(null))) });
  return [only([0, 1, 2, 3, 4, 5, 6, 7]), only([0, 1, 2, 3, 4, 6, 7]), only([1, 2])];
}

function sketch(tuning, name) {
  const s = normaliseSketch({
    v: SKETCH_VERSION, name, bpm: 96, tuning, loop: true,
    lanes: ["piano", "bass", "drums", "pad", "pluck", "lead", "epiano", "organ"].map((preset) => ({ preset, mute: false })),
    sections: sections(tuning),
  });
  if (s.tuning !== tuning || s.sections.length !== 3) throw new Error(`the ${tuning} sketch did not survive normaliseSketch`);
  return s;
}

/** What Touch reads at boot: the sketch, the board, the theme, the language. */
function storage({ tuning, theme = "dark", lang = "en", prefs = {} }) {
  return {
    "microtone-touch:sketch": sketch(tuning, "Harmonic sevenths"),
    "microtone-touch:prefs": { layout: "wicki", size: 30, octaves: {}, ...prefs },
    "microtone-touch:theme": theme,
    "microtone-touch:lang": lang,
  };
}

// ── in the page ──────────────────────────────────────────────────────────────

/** The page is wired and the sound is running; then the helpers every scene
 *  uses, as `__shot`. */
async function ready({ timeout }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = timeout, what = String(fn)) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  await until(() => document.getElementById("startVeil")?.dataset.state === "ready", timeout, "the start veil");
  const t = window.__touch;
  await t.startAudio();
  await until(() => document.getElementById("startVeil").hidden, timeout, "the sound to start");
  const { visibleKeys } = await import("/src/lattice.js");
  window.__shot = {
    t, sleep, until,
    /** Select lane `l`, as a tap on its header does (a tap on the one
     *  already selected would open its sheet instead). */
    lane(l) { if (t.ui.lane !== l) t.grid.handlers.lane(l); },
    async play() {
      if (!t.playing) t.togglePlay();
      await until(() => t.audio.isPlaying(), 5000, "the song to start");
    },
    row: () => t.audio.getTrackerRow(),
    /**
     * Where a hand would hold `notes` on the board, in its own px: a key of
     * the first note's pitch class nearest `towards` (fractions of the
     * board), then for each other note the key of its class nearest that
     * one — whatever octave the board happens to show. Only keys wholly on
     * the board count.
     */
    keys(notes, { towards = [0.5, 0.5] } = {}) {
      const kb = t.keyboard;
      const { size, preset } = kb.cfg;
      const keys = [...visibleKeys(kb.width, kb.height, size, kb._origin(), kb._steps().tilt)]
        .filter(({ x, y }) => x > size && x < kb.width - size && y > size && y < kb.height - size)
        .map((k) => ({ ...k, note: kb._key(k.q, k.r).note }));
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const nearest = (n, to) => keys.filter((k) => (k.note - n) % preset.interval === 0)
        .sort((a, b) => dist(a, to) - dist(b, to))[0];
      const first = nearest(notes[0], { x: kb.width * towards[0], y: kb.height * towards[1] });
      if (!first) throw new Error("the chord's first note is not on the board");
      return notes.map((n, i) => {
        const k = i === 0 ? first : nearest(n, first);
        if (!k) throw new Error(`note ${n} is not on the board`);
        return { x: k.x, y: k.y };
      });
    },
    /** Fingers down on the board at `points` (its own px), held until the
     *  page goes: the pointers the keyboard takes from a touch screen. */
    press(points) {
      const canvas = t.keyboard.canvas;
      const rect = canvas.getBoundingClientRect();
      points.forEach(({ x, y }, i) => canvas.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 100 + i, pointerType: "touch", isPrimary: i === 0, bubbles: true, cancelable: true,
        clientX: rect.left + x, clientY: rect.top + y,
      })));
    },
  };
  return true;
}

export default {
  name: "touch",
  root: at("../../../microtone-touch-worker/"),
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  ready,
  shots: [
    // 1 — the sketch playing in 31-TET on the Bosanquet board, the lead lane
    // selected and a C7 chord — its seventh the harmonic 7/4 — under three
    // fingers, while the other lanes ring their notes on the keys.
    {
      out: [at(`${OUT}Screenshot1.png`)],
      url: "index.html",
      storage: storage({ tuning: "31", prefs: { layout: "bosanquet" } }),
      arg: { hold: [0, 386, 969].map((c) => note(c + 1200, "31")) },
      async stage({ hold }) {
        __shot.lane(5);
        await __shot.play();
        await __shot.until(() => __shot.row() >= 9 && __shot.row() < 16, 10000, "row 9");
        __shot.press(__shot.keys(hold));
      },
    },
    // 2 — Fat fingers on the harmonic table: one finger where three keys
    // meet plays the triad they make. 19-TET, the piano lane, stopped.
    {
      out: [at(`${OUT}Screenshot2.png`)],
      url: "index.html",
      storage: storage({ tuning: "19", prefs: { layout: "harmonic", fat: true, size: 40 } }),
      arg: { triad: [0, 386, 702].map((c) => note(c, "19")) },
      async stage({ triad }) {
        const keys = __shot.keys(triad);
        __shot.press([{ x: keys.reduce((a, k) => a + k.x, 0) / 3, y: keys.reduce((a, k) => a + k.y, 0) / 3 }]);
      },
    },
    // 3 — in Korean, in Shi'er lü at the hyang-ak pitch (C4 at 311 Hz): the
    // keys and the grid name the twelve lü. The light theme.
    {
      out: [at(`${OUT}Screenshot3.png`)],
      url: "index.html",
      storage: storage({ tuning: "hyangak", theme: "light", lang: "ko" }),
      arg: { hold: [0, 386, 702].map((c) => note(c + 1200, "hyangak")) },
      async stage({ hold }) {
        __shot.lane(5);
        await __shot.play();
        await __shot.until(() => __shot.row() >= 9 && __shot.row() < 16, 10000, "row 9");
        __shot.press(__shot.keys(hold));
      },
    },
    // 4 — held sideways: the song and the board side by side, in
    // Bohlen–Pierce — thirteen steps to the tritave, no octave at all — on
    // the degree run, the board that reaches every step of every tuning.
    // The chord held is BP's own triad, 3:5:7.
    {
      out: [at(`${OUT}Screenshot4.png`)],
      url: "index.html",
      viewport: { width: 844, height: 390 },
      storage: storage({ tuning: "bp", prefs: { layout: "step" } }),
      arg: { hold: [0, 884, 1467].map((c) => note(c, "bp")) },
      async stage({ hold }) {
        __shot.lane(0);
        await __shot.play();
        await __shot.until(() => __shot.row() >= 0x19 && __shot.row() < 0x20, 10000, "row $19");
        __shot.press(__shot.keys(hold, { towards: [0.4, 0.6] }));
      },
    },
    // 5 — a drum lane: the board turns into eight pads, the kick and the
    // closed hat under two fingers.
    {
      out: [at(`${OUT}Screenshot5.png`)],
      url: "index.html",
      storage: storage({ tuning: "31" }),
      async stage() {
        __shot.lane(2);
        await __shot.play();
        await __shot.until(() => __shot.row() >= 0x23 && __shot.row() < 0x28, 10000, "row $23");
        const kb = __shot.t.keyboard;
        __shot.press([{ x: kb.width * 0.125, y: kb.height * 0.75 }, { x: kb.width * 0.625, y: kb.height * 0.75 }]);
      },
    },
    // 6 — Temperament…: every tuning Touch offers.
    {
      out: [at(`${OUT}Screenshot6.png`)],
      url: "index.html",
      storage: storage({ tuning: "31" }),
      async stage() {
        document.getElementById("menuBtn").click();
        document.querySelector('#menu [data-act="tuning"]').click();
        await __shot.until(() => document.getElementById("sheet").open, 5000, "the Temperament sheet");
      },
    },
  ],
};
