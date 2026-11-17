// The scene: "It plays what people actually wrote" — four files that ask a lot
// of a player, an act each: Changing Waves (4mat, .mod, Invert Loop), Fourth
// Symmetriad (Skaven, .it, filters, envelopes and new-note actions), First
// Adlib Attempt (Skaven, .s3m, nothing but OPL instruments) and the GeneralUser
// GS SoundFont (heard through Huygens' Clock, our own demo, which is built on
// it). The same four as the README's "It plays what people actually wrote" and
// the product page's customer stories: keep the claims in step with those.
//
// Open it as http://127.0.0.1:8950/tools/promo/?scene=works after `make works`.
// The three modules are converted from their originals by the same converters
// the app runs on an import (Makefile), so the film plays what an import plays.
//
// An act's `events` are keyed to SECONDS since its Play (`at`); it fades out at
// `play` seconds over `fade`. `gain` is the engine's master volume for the act:
// the four are matched to about −15 dBFS RMS over their excerpts (measured
// offline, 2026-11-18). Two need it to stay off the clip as well: Changing
// Waves and First Adlib Attempt convert hot enough to clip the bus at full
// gain (≈ 5 and 11 dB above OpenMPT's level). Revisit once the import levels
// are settled.
//
// The words are public: no internal names, no item numbers. A part of a song
// is a lane; an effect is named as the manual names it.
//
// THE SONGS ARE NOT OURS. Recording a take for yourself is one thing;
// publishing it needs 4mat's and Skaven's leave for their music. GeneralUser
// GS's licence lets it be shipped, and Huygens' Clock is our own.

/** The instrument list's row for an instrument, by its name. */
const inst = (name) => (d) =>
  d.app.instrumentsView?.rowEls?.find((r) => r.el.querySelector(".name")?.textContent.trim() === name)?.el;
/** The instrument list's first row. */
const firstInst = (d) => d.app.instrumentsView?.rowEls?.[0]?.el;
/** A sub-tab of the instrument editor, by its label. */
const subtab = (label) => (d) =>
  d.$$("#instrumentsHost .subtabs button").find((b) => b.textContent.trim() === label);
/** The sample list's row for sample `index`. */
const sampleRow = (index) => (d) => d.app.samplesView?.rowEls?.find((r) => r.index === index)?.el;
/** The Samples view's waveform. */
const waveform = (d) => d.app.samplesView?.canvas;
/** The instrument editor's envelope canvas (Vol env, Filter…), when one shows. */
const envelope = (d) => d.app.instrumentsView?.envCanvas?.canvas?.isConnected && d.app.instrumentsView.envCanvas.canvas;
/** An OPL instrument's operators. */
const operators = (d) => d.$("#instrumentsHost .opl-edit");

const ACTS = [
  {
    song: "build/changing_waves.taud",
    title: "Changing Waves",
    by: "4mat",
    tag: "4mat · ProTracker module",
    kicker: "1 · .mod",
    gain: 0.33,
    play: 50,
    events: [
      { at: 1.5, run: (d) => d.caption([
        "Changing Waves, by 4mat: a ProTracker module.",
        "It uses ProTracker's Invert Loop in 377 cells.",
      ], { ms: 7500 }) },
      { at: 11, run: (d) => d.caption([
        "Invert Loop rewrites the looping sample a byte at a time, while it plays,",
        "so the sound never settles. A player that skips it plays a different song.",
      ], { ms: 8500 }) },
      { at: 18, run: async (d) => {
        await d.tab("samples");
        // 003 "this requires 100%": a sample Invert Loop is flipping right
        // now, so its orange grows while the camera is on it.
        await d.click(sampleRow(3));
      } },
      { at: 23, run: async (d) => {
        d.caption([
          "Microtone flips each byte as ProTracker does,",
          "and paints every byte it has flipped so far.",
        ], { ms: 9000 });
        await d.wait(800);
        d.ring(waveform, { ms: 7000 });
      } },
      { at: 34, run: (d) => d.caption([
        "Stop the transport, and the sample is exactly as it was.",
        "The file itself is never touched.",
      ], { ms: 8000 }) },
      { at: 44, run: (d) => d.tab("timeline") },
    ],
  },
  {
    song: "build/4THSYM.taud",
    title: "Fourth Symmetriad",
    by: "Skaven",
    tag: "Skaven · Impulse Tracker module",
    kicker: "2 · .it",
    play: 46,
    events: [
      { at: 1.5, run: (d) => d.caption([
        "Fourth Symmetriad, by Skaven: an Impulse Tracker module.",
        "66 instruments, 63 of them through the resonant filter.",
      ], { ms: 7500 }) },
      { at: 10, run: async (d) => {
        await d.tab("instruments");
        await d.click(inst("Chip5ths.sweep up.rez"));
        await d.click(subtab("Filter"));
      } },
      { at: 12, run: async (d) => {
        d.caption([
          "Nearly every instrument has envelopes, and the filter moves under them.",
          "Each new note can cut, continue, release or fade the one before.",
        ], { ms: 9000 });
        await d.wait(600);
        d.ring(envelope, { ms: 6500 });
      } },
      { at: 22, run: (d) => d.click(subtab("Vol env")) },
      { at: 23, run: (d) => d.caption([
        "Old notes keep ringing under the ones that replaced them.",
        "Get one of those rules wrong, and the mix falls apart.",
      ], { ms: 8500 }) },
      { at: 33, run: async (d) => {
        await d.tab("timeline");
        d.caption([
          "The engine follows Impulse Tracker's lineage,",
          "checked against the source code of the trackers that kept it.",
        ], { ms: 8500 });
      } },
    ],
  },
  {
    song: "build/adlib.taud",
    title: "First Adlib Attempt",
    by: "Skaven",
    tag: "Skaven · Scream Tracker 3 module",
    kicker: "3 · .s3m",
    gain: 0.3,
    play: 42,
    events: [
      { at: 1.5, run: (d) => d.caption([
        "First Adlib Attempt, by Skaven: a Scream Tracker 3 module.",
        "Not one sample: 29 instruments for the AdLib card's FM chip.",
      ], { ms: 7500 }) },
      { at: 10, run: async (d) => {
        await d.tab("instruments");
        await d.click(firstInst);
        await d.click(subtab("OPL"));
      } },
      { at: 12, run: async (d) => {
        d.caption([
          "Each one becomes an OPL instrument of Microtone's own,",
          "register for register, played on an emulated chip.",
        ], { ms: 8500 });
        await d.wait(600);
        d.ring(operators, { ms: 6500 });
      } },
      // The message is written into the names of empty instrument slots, as
      // S3M authors did; the app lists only instruments with something in
      // them, so the quote is a caption over the song playing.
      { at: 22, run: async (d) => {
        await d.tab("timeline");
        d.caption([
          "In the song's own message:",
          "“Seems to work fine. Didn't even need any samples…!”",
        ], { ms: 9000 });
      } },
    ],
  },
  {
    song: "../../microtone-worker/assets/demo_projects/Huygens_clock.taud",
    title: "GeneralUser GS",
    by: "S. Christian Collins",
    tag: "the SoundFont · heard in Huygens' Clock",
    kicker: "4 · .sf2",
    play: 42,
    events: [
      { at: 1.5, run: (d) => d.caption([
        "GeneralUser GS: the SoundFont Microtone ships as its MIDI bank.",
        "Heard here in Huygens' Clock, our own demo, built on its instruments.",
      ], { ms: 8500 }) },
      // A Layered instrument of SoundFont patches: its layers are the
      // "layers on curves of their own" the next caption speaks of.
      { at: 11, run: async (d) => {
        await d.tab("instruments");
        await d.click(inst("Marimba"));
      } },
      { at: 13, run: (d) => d.caption([
        "It sounds far better than its size, by leaning on the corners of the standard:",
        "velocity curves per instrument, layers on curves of their own, tiny loops.",
      ], { ms: 9000 }) },
      { at: 23, run: (d) => d.caption([
        "Each one is carried through the conversion:",
        "the drums keep their dynamics, and the marimba stays in tune.",
      ], { ms: 8500 }) },
      { at: 33, run: (d) => d.tab("timeline") },
    ],
  },
];

export default {
  base: import.meta.url,
  acts: ACTS,
  theme: "dark",
  lang: "en",
  site: "microtone.cc",

  /** From the sync flash: the title card, held, then the first act. */
  async intro(d) {
    d.card({
      wordmark: true,
      kicker: "It plays what people actually wrote",
      sub: "Four files that ask a lot of a player",
    }, { full: true, instant: true });
    await d.wait(4000);
  },

  /** Every act opens on its own card, under which the cursor presses Play. */
  async actIntro(d, act) {
    d.card({ kicker: act.kicker, title: act.title, sub: act.by });
    await d.wait(2200);
    await d.click("#playSong", { ms: 800, after: 0 });
    await d.wait(500);
    d.hideCard();
  },

  /** After the last act: the end card, held still for the cut. */
  async outro(d) {
    await d.wait(400);
    d.card({
      wordmark: true,
      kicker: "We don't just support the format.",
      title: "We support what people actually did with it.",
      sub: "microtone.cc · free and open source (GPL-3.0) · runs in your browser",
      foot: "Changing Waves by 4mat · Fourth Symmetriad and First Adlib Attempt by Skaven · GeneralUser GS by S. Christian Collins",
    }, { full: true });
    await d.wait(7000);
  },
};
