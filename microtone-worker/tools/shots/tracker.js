// The tracker's eight promo shots — README.md's Screenshot1..8.png, in the
// order its "A look around" walks through them. Run by make-screenshots.js;
// every function below runs IN THE PAGE (it is sent over CDP as source), so it
// can reach nothing here but its own argument.
//
// The songs are corpus songs (test/corpus/, local-only). All eight are the
// dim theme at 1280×800, the size the README was written around.

import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const song = (name) => `index.html?load=test/corpus/${encodeURIComponent(name)}&theme=dim`;

/** The song is in and the editor is drawn; then the helpers every scene
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
  const m = await until(() => window.__microtone?.store.doc && window.__microtone, timeout, "the song to load");
  await until(() => !document.getElementById("splash"), timeout, "the boot splash to go");
  const { store } = m;
  window.__shot = {
    m, store, sleep, until,
    tab(view) {
      document.querySelector(`#tabs button[data-view="${view}"]`).click();
    },
    /** The playhead has reached `row` of `cue` (or gone past it). */
    reached: (cue, row) => {
      const c = store.audio.getCuePosition();
      return c > cue || (c === cue && store.audio.getTrackerRow() >= row);
    },
    /** What the app's own play-from-cursor does, from anywhere. */
    async play(cue = 0, row = 0) {
      await window.__microtoneEnsureAudio();
      store.sync.flushPatterns();
      store.audio.resetSampleFxState(0);
      store.audio.setCuePosition(0, cue);
      store.audio.setTrackerRow(0, row);
      store.audio.play(0);
      await until(() => store.audio.isPlaying(), 5000, "the song to start");
    },
    /** Two animation frames: whatever a change scheduled has painted. */
    frames: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  };
  return true;
}

export default {
  name: "tracker",
  root: at("../../"),
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  ready,
  shots: [
    // 1 — the Timeline, playing, with the master strip's scopes and meters
    // live: two seconds' run-up into 0001:05, the densest stretch of the
    // opening. (Each wait below stops a couple of rows short: the capture
    // itself takes that long.)
    {
      out: [at("../../../Screenshot1.png"), at("../../screenshot.png")],
      url: song("4THSYM.taud"),
      async stage() {
        await __shot.play(0, 0x2b);
        await __shot.until(() => __shot.reached(1, 0x03), 10000, "0001:03");
      },
    },
    // 2 — Cues: the order list, a pattern number per lane per row.
    {
      out: [at("../../../Screenshot2.png")],
      url: song("4THSYM.taud"),
      async stage() {
        __shot.tab("cues");
        await __shot.frames();
      },
    },
    // 3 — the pattern editor, the song's first patterns side by side.
    {
      out: [at("../../../Screenshot3.png")],
      url: song("town.taud"),
      async stage() {
        __shot.tab("pattern");
        const pv = __shot.m.patternView;
        pv.panes.forEach((p, i) => p.setPattern(i));
        pv.refreshAllHeaders();
        await __shot.frames();
      },
    },
    // 4 — the sample bin mid-song: sample 010 is being Invert-Looped, and the
    // bytes the effect has flipped so far are tinted. The tint is everything
    // flipped since Play, so the song plays from the top: ~40 s.
    {
      out: [at("../../../Screenshot4.png")],
      url: song("changing_waves.taud"),
      async stage() {
        __shot.tab("samples");
        __shot.m.samplesView.selectSample(10);
        await __shot.play(0, 0);
        await __shot.until(() => __shot.reached(5, 0x0f), 60000, "cue 5 row $0F");
      },
    },
    // 5 — the instrument editor on a SoundFont patch, list and badges beside.
    {
      out: [at("../../../Screenshot5.png")],
      url: song("Onestop.taud"),
      async stage() {
        __shot.tab("instruments");
        const iv = __shot.m.instrumentsView;
        iv.selected = 0x18;
        iv.tab = "general";
        iv.refresh();
        iv.rowEls.find((r) => r.slot === 0x18)?.el.scrollIntoView({ block: "center" });
        await __shot.frames();
      },
    },
    // 6 — the Mastering tab metering the song as it plays: long enough in for
    // the integrated loudness and the loudness range to mean something.
    {
      out: [at("../../../Screenshot6.png")],
      url: song("town.taud"),
      async stage() {
        __shot.tab("mastering");
        await __shot.play(0, 0);
        await __shot.until(() => __shot.reached(3, 0x27), 40000, "cue 3 row $27");
      },
    },
    // 7 — the Project tab.
    {
      out: [at("../../../Screenshot7.png")],
      url: song("town.taud"),
      async stage() {
        __shot.tab("project");
        await __shot.frames();
      },
    },
    // 8 — the Keymap tab: Bosanquet–Wilson fitted to 19-TET, saved as a layout
    // of its own and bound to that tuning. No corpus song is written in
    // 19-TET, so the song's display notation (Project tab) is switched to it
    // first — which moves no notes.
    {
      out: [at("../../../Screenshot8.png")],
      url: song("WHEN.taud"),
      async stage() {
        const lib = __shot.m.keymapLib;
        await __shot.until(() => lib._ready, 10000, "the keymap library");
        lib.setActive(await lib.save({
          name: "Bosanquet–Wilson 19-TET", unit: "deg", rows: ["Z", "A", "Q", "N"],
          origin: { code: "KeyA", value: -1 }, x: 3, y: -1, upper: 0, notation: 190,
        }));
        __shot.tab("project");
        __shot.m.projectView.changeNotation(190);
        // A display setting, not an edit the shot should show as unsaved.
        __shot.store.doc.dirty = false;
        document.getElementById("stDirty").hidden = true;
        __shot.tab("keymap");
        await __shot.frames();
      },
    },
  ],
};
