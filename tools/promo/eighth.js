// The scene: "Eighth Baffling Incongruity Theorem" (8-BIT), 80 bars of 8/8 at
// ♩ = 128 — a bar every 1.875 s, 2:30 in all, built from
// OoT_musical_experiments/eight-bit/Eighth.tml. The song is only something
// (of our own) to play: the captions talk about the app, never the music.
//
// Every `bar` below is a 1-based bar of the song, fractional allowed (17.5 =
// half-way through bar 17); an event runs when the playhead gets there, and
// the next waits for it to finish. Captions are timed in bars too. Edit the
// words and the timings freely — the director only needs the shape.
//
// The words are public: no internal names, no item numbers.

const CAP = 3.5; // a caption's usual life, in bars (6.6 s)

/** The instrument list's row for an instrument, by its name. */
const inst = (name) => (d) =>
  d.app.instrumentsView?.rowEls?.find((r) => r.el.querySelector(".name")?.textContent.trim() === name)?.el;
/** A sub-tab of the instrument editor (FM / Options / Mixing), by its label. */
const subtab = (label) => (d) =>
  d.$$("#instrumentsHost .subtabs button").find((b) => b.textContent.trim() === label);
/** The FM rack's "ratio" column — every operator's cell of it. */
const ratios = (d) => d.$$("#instrumentsHost td.detCell");
/** A Mixing-tab or Mastering-tab unit, by the name on its title bar. */
const unit = (host, name) => (d) =>
  d.$$(`${host} .mst-unit-name`).find((e) => e.textContent.trim().toLowerCase() === name)?.closest(".mst-unit");
const scope = (name) => (d) =>
  d.$$("#masteringHost .mst-scope-head span").find((e) => e.textContent.trim().toLowerCase() === name)?.closest(".mst-scope");
/** The FM tab's "Design timbre…" button. */
const designTimbre = (d) =>
  d.$$("#instrumentsHost button").find((b) => /Design timbre/.test(b.textContent));
/** A section in the Motif view's Structure panel. */
const structure = (name) => (d) =>
  d.$$(".motif-side-body button.motif-tree-row").find((b) => b.querySelector(".motif-tree-name")?.textContent.trim() === name);

/** Scroll the Motif editor so the line holding `text` sits a little below its top. */
async function motifScrollTo(d, text, ms) {
  const ta = d.$(".motif-text");
  const at = ta.value.indexOf(text);
  if (at < 0) return;
  const line = ta.value.slice(0, at).split("\n").length - 1;
  const lineH = ta.scrollHeight / ta.value.split("\n").length;
  await d.scroll(ta, line * lineH - ta.clientHeight * 0.18, ms);
}

export default {
  base: import.meta.url,
  song: "build/Eighth.taud",
  theme: "dark",
  lang: "en",
  cueBars: 4,
  barRows: 16,
  site: "microtone.cc",

  /** From the sync flash to the downbeat: the title card (shown under the
   *  flash, no fade), then the cursor presses Play about two seconds after. */
  async intro(d) {
    d.card({
      wordmark: true,
      kicker: "a tracker workstation for any sound, in any tuning",
    }, { instant: true });
    await d.at(0.9);
    await d.click("#playSong", { ms: 950, after: 0 });
  },

  events: [
    { bar: 1.6, run: (d) => d.hideCard() },

    // ── the Timeline, then every lane at once ─────────────────────────────
    { bar: 3, run: (d) => d.caption([
      "Microtone is a music tracker that runs in a browser tab.",
      "No install, no account needed.",
    ], { bars: CAP }) },
    { bar: 9, run: async (d) => {
      d.caption([
        "Any tuning, not just the twelve: 19-TET, 31-TET, Bohlen–Pierce",
        "and a temperament you drew yourself are all the same kind of thing to it.",
      ], { bars: CAP });
      await d.wait(900);
      await d.click("#tbCells");
    } },
    { bar: 13, run: (d) => d.caption([
      "Pick a notation preset or draw your own in the Notation Maker:",
      "entry, display and stepping snap to its degrees.",
    ], { bars: CAP }) },

    // ── instruments ───────────────────────────────────────────────────────
    { bar: 16.75, run: (d) => d.tab("instruments") },
    { bar: 17, run: async (d) => {
      await d.click(inst("Grid Keys"));
      d.caption([
        "Instruments that are more than samples:",
        "FM racks wire instruments into one another, every ratio in cents.",
      ], { bars: CAP });
      await d.wait(1200);
      d.ring(ratios, { ms: 4000 });
    } },
    { bar: 20.5, run: (d) => d.click(inst("Tempered Twin")) },
    { bar: 21, run: async (d) => {
      d.caption([
        "The Timbre designer builds a sound from sine partials",
        "and can put every one of them on your tuning's steps.",
      ], { bars: CAP });
      await d.wait(600);
      await d.point(designTimbre);
      d.ring(designTimbre, { ms: 3500 });
    } },

    // ── a mixing chain ────────────────────────────────────────────────────
    { bar: 24.6, run: (d) => d.click(inst("Lemma Bell")) },
    { bar: 25, run: async (d) => {
      await d.click(subtab("Mixing"));
      d.caption([
        "Any instrument can have its own mixing chain:",
        "EQ, dynamics, saturation, unison, tape delay, reverb.",
      ], { bars: 4 });
      await d.wait(700);
      await d.point(unit("#instrumentsHost", "tape delay"), { dy: 0.15 });
      d.ring(unit("#instrumentsHost", "tape delay"), { ms: 5000 });
    } },

    // ── Motif ─────────────────────────────────────────────────────────────
    { bar: 32.6, run: (d) => d.tab("motif") },
    { bar: 33, run: async (d) => {
      d.caption([
        "Songs can be written as programs,",
        "in Motif: Microtone's own music language.",
      ], { bars: 4 });
      await d.wait(800);
      await d.click(structure("Proof"));
    } },
    { bar: 36, run: (d) => motifScrollTo(d, "33–48  PROOF", 3500) },
    { bar: 38, run: (d) => d.caption([
      "Notes, instruments, mix and master, all from one program,",
      "which travels inside the project. Change it and build again.",
    ], { bars: 4 }) },
    { bar: 42.5, run: (d) => motifScrollTo(d, "49–56  COUNTEREXAMPLE", 3000) },
    { bar: 44.6, run: (d) => d.tab("timeline") },
    { bar: 45, run: async (d) => {
      await d.click("#tbPitchPlot");
      d.caption([
        "The pitch plot draws each lane's melody behind its notes:",
        "a tick per note, joined into a contour, tabbed with its register.",
      ], { bars: 4 });
    } },
    { bar: 53, run: (d) => d.caption([
      "Opens what you already have:",
      ".mod, .s3m, .xm and .it, and MIDI through a SoundFont.",
    ], { bars: CAP }) },

    // ── mastering, then the order list ────────────────────────────────────
    { bar: 56.6, run: (d) => d.tab("mastering") },
    { bar: 57, run: async (d) => {
      d.caption([
        "Master it in the same window:",
        "EQ, compressor and limiter, with loudness, true-peak and gain-reduction meters.",
      ], { bars: 4 });
      await d.wait(1500);
      d.ring(scope("loudness"), { ms: 3500 });
    } },
    { bar: 61, run: async (d) => {
      d.caption("The chain you hear is the chain the export renders through.", { bars: 3 });
      await d.wait(600);
      d.ring(scope("levels"), { ms: 3500 });
    } },
    { bar: 64.6, run: (d) => d.tab("cues") },
    { bar: 65, run: (d) => d.caption([
      "Cues are the song's order list:",
      "each lane has its own pattern number on every row.",
    ], { bars: CAP }) },
    { bar: 68.6, run: (d) => d.tab("timeline") },
    { bar: 69, run: (d) => d.caption([
      "Export stereo, 5.1, 7.1 or ambisonic B-format,",
      "or stems: one mono WAV per lane.",
    ], { bars: CAP }) },
    { bar: 73, run: (d) => d.caption([
      "Desktop builds for Linux, Windows and macOS, too:",
      "the same tracker in a window of its own, working offline.",
    ], { bars: CAP }) },
  ],

  /** After the last note: the end card, held still for the cut. */
  async outro(d) {
    await d.wait(600);
    d.card({
      wordmark: true,
      title: "microtone.cc",
      sub: "Free and open source (GPL-3.0). Runs in your browser.",
      lines: [
        "Any tuning: 12, 19, 31-TET, Bohlen–Pierce, or one you draw yourself",
        "Opens .mod, .s3m, .xm, .it and MIDI",
        "Mixing chains, mastering, and songs written as programs",
      ],
      foot: "Support the project: ko-fi.com/curioustorvald",
    }, { full: true });
    await d.wait(7000);
  },
};
