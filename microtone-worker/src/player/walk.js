// The song walk (item 373): play a song through the real engine, as fast as
// it renders, the way the Microtone Player's radio would play it — until the
// LoopWatch's seam, or the song's own end — and report what it heard:
// how long that took, and its tempo.
//
// The tempo is BPM ÷ speed (songfacts.js `tempoOf`), and a song whose tempo
// moves is given the TIME-weighted average of it: every chunk counts for the
// time it lasts, so a slow middle section weighs what it is heard for.
//
// Runs in Node (the Music Hub's catalogue) and in a browser. Nothing here is
// on an audio thread; the engine is the same one taudplay plays.

import { WasmTaudEngine } from "../../core/engine/wasm-engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../../core/engine/constants.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { LoopWatch } from "./radio.js";
import { tempoOf } from "./songfacts.js";

/** The longest a walk listens before it calls the song over anyway. */
export const WALK_LIMIT_SEC = 20 * 60;

/**
 * Walk song `songIndex` of a parsed file (`parseTaud`'s result).
 * Returns `{ seconds, tempo, minTempo, maxTempo, ending }`, `ending` one of
 * "seam" (looped, then the radio moved on), "end" (the song stopped itself)
 * or "limit" (neither, within WALK_LIMIT_SEC).
 */
export function walkSong(parsed, songIndex = 0, { limitSec = WALK_LIMIT_SEC } = {}) {
  const eng = new WasmTaudEngine(SAMPLING_RATE);
  loadIntoEngine(eng, parsed, songIndex);
  eng.setCuePosition(0, 0);
  eng.setTrackerRow(0, 0);
  eng.play(0);
  const watch = new LoopWatch();
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const dt = TRACKER_CHUNK / SAMPLING_RATE;
  const limit = Math.ceil(limitSec / dt);
  let weighted = 0, heard = 0, minTempo = Infinity, maxTempo = 0, ending = "limit", n = 0;
  watch.observe(eng.getCuePosition(0), true);
  for (; n < limit; n++) {
    const t = tempoOf(eng.getBPM(0), eng.getTickRate(0));
    eng.renderChunk(0, out);
    if (t > 0) {
      weighted += t * dt;
      heard += dt;
      if (t < minTempo) minTempo = t;
      if (t > maxTempo) maxTempo = t;
    }
    const ev = watch.observe(eng.getCuePosition(0), eng.isPlaying(0));
    if (ev === "seam" || ev === "end") { ending = ev; n++; break; }
  }
  // A sum of thousands of chunk-long products leaves float noise in the last
  // digits (160.00000000003); a millionth of a row per second is plenty.
  const round = (t) => Math.round(t * 1e6) / 1e6;
  const tempo = heard > 0 ? round(weighted / heard) : 0;
  return {
    seconds: n * dt,
    tempo,
    minTempo: minTempo === Infinity ? tempo : round(minTempo),
    maxTempo: maxTempo ? round(maxTempo) : tempo,
    ending,
  };
}
