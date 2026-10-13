// Hearing one call of a Motif program — `melody(…)`, `hit(…)`, a function of
// your own — without building the song. What the call writes (captureCall,
// worked out in the Motif worker) is written into scratch patterns just past
// the project's own and played through scratch cues that stop at the end, the
// way the Patterns view previews a pattern. The project is not touched: the
// patterns are the engine's alone, and are cleared again when the preview ends.
//
// It plays through the OPEN project's instruments, so it needs to know which
// slot each instrument of the program sits in there: the slots a build in
// this session reported, or — for a song of soundfont presets alone — the
// order they are declared in (§7.3), when the open project was built from a
// program that declares the same instruments.

import { encodeCell } from "../motif/compile.js";
import { noise2 } from "../motif/stdlib.js";
import { CUE_EMPTY } from "../../core/format/taud-const.js";

/** The last cue index the engine keeps; previews run up to it and halt there
 *  (the Patterns view's own preview uses it too). */
const PREVIEW_LAST_CUE = 8191;
/** Rows the preview runs on after the call's last event, for the tails. */
const TAIL_BARS = 1;

/**
 * Play a capture. `slotOf(instId)` → the instrument's slot in the open project.
 * Returns {stop()} — or null when there is nothing to play.
 */
export async function playCapture(store, cap, slotOf) {
  if (!store.doc || cap.first === null) return null;
  await window.__microtoneEnsureAudio?.();
  const audio = store.audio;
  if (!audio) return null;
  const song = store.doc.songs[store.songIndex];
  const wide = store.doc.wideCells;
  const size = wide ? 16 : 8;
  const cueRows = cap.song.barRows * cap.song.cueBars;
  const r0 = cap.first;
  const r1 = Math.min(cap.song.rows, cap.last + 1 + TAIL_BARS * cap.song.barRows);
  const pages = Math.max(1, Math.ceil((r1 - r0) / 64));
  if (pages > PREVIEW_LAST_CUE) return null;

  // the scratch patterns: just past the project's own, page by page, lane by lane
  const base = song.patterns.length;
  const slots = [];
  const cues = [];
  for (let p = 0; p < pages; p++) {
    const words = new Uint16Array(store.doc.channelCount).fill(CUE_EMPTY);
    for (const lane of cap.lanes) {
      if (lane.index >= words.length) continue;
      const bytes = new Uint8Array(64 * size);
      for (let r = 0; r < 64; r++) bytes.set(encodeCell(null, 1, 0, wide), r * size);
      let any = false;
      for (const [row, c] of lane.cells) {
        const r = row - r0 - p * 64;
        if (r < 0 || r >= 64) continue;
        const cell = { ...c, inst: c.instId ? { slot: slotOf(c.instId) ?? 0 } : undefined };
        const jit = lane.jitter ? Math.round(noise2(lane.index, row % cueRows) * lane.jitter) : 0;
        bytes.set(encodeCell(cell, lane.trim, jit, wide), r * size);
        any = true;
      }
      if (!any) continue;
      const slot = base + slots.length;
      slots.push(slot);
      audio.uploadPattern(slot, bytes);
      words[lane.index] = slot;
    }
    // the last page stops the song: HALT is instruction word 0's bit 8, carried
    // in lane 8's top bit (the cue sheet packs instructions into lane words)
    if (p === pages - 1) words[8] |= 0x8000;
    const bytes = new Uint8Array(words.length * 2);
    words.forEach((w, i) => { bytes[i * 2] = w & 0xff; bytes[i * 2 + 1] = w >>> 8; });
    cues.push(bytes);
  }

  store.sync?.flushPatterns();
  audio.stop(0);
  audio.setBPM(0, cap.song.tempo);
  audio.setTickRate(0, cap.song.speed);
  const firstCue = PREVIEW_LAST_CUE - pages + 1;
  cues.forEach((bytes, i) => audio.uploadCue(firstCue + i, bytes));
  audio.resetSampleFxState(0);
  audio.setCuePosition(0, firstCue);
  audio.setTrackerRow(0, 0);
  audio.play(0);

  let started = false, done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    for (const s of slots) audio.clearPattern(s);
  };
  // the engine stops itself at the HALT; tidy up once it has
  const poll = setInterval(() => {
    if (audio.isPlaying()) started = true;
    else if (started) cleanup();
  }, 200);
  return {
    stop() {
      if (!done) audio.stop(0);
      cleanup();
    },
    get playing() { return !done; },
  };
}
