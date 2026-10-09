// Measure how far each Ixmp zone of an instrument actually sounds from the note
// it is asked for, and work out the detune that puts it back on the grid.
//
// A note is rendered held (no effects) through a scratch engine; its pitch is the
// median of a YIN-style period estimate over many frames, so recorded vibrato
// and chorus layers average out to the centre a listener hears.

import { TaudEngine } from "../../core/engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../../core/engine/constants.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { noteWord } from "./lib.mjs";

const hzOf = (word) => 261.6255653 * 2 ** ((word - 0x5000) / 4096);

/** One-pattern song: `word` on instrument `inst` at row 0, held 64 rows. */
function heldNoteDoc(bank, inst, word, vol) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = word & 0xff; pat[1] = word >>> 8; pat[2] = inst; pat[3] = vol;
  const cue = new Uint16Array(64).fill(0x7fff);
  cue[0] = 0;
  return {
    is64Channel: false, fmtVer: 2, sampleInstImage: bank.sampleInstImage, ixmp: bank.ixmp, meta: {},
    songs: [{ numVoices: 1, bpm: 120, tickRate: 6, tuningBaseNote: 0x5c00, tuningFreq: 440, globalFlags: 0,
      globalVolume: 255, mixingVolume: 128, surroundModel: 0, patterns: [pat], cues: [cue] }],
  };
}

function renderMono(doc, seconds) {
  setRandomSource(makeSeededRandom(1)); // any swing in a zone measures the same every build
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc, 0);
  eng.setCuePosition(0, 0);
  eng.play(0);
  const ts = eng.playheads[0].trackerState;
  const n = Math.ceil((seconds * SAMPLING_RATE) / TRACKER_CHUNK);
  const out = new Float32Array(n * TRACKER_CHUNK);
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  for (let c = 0; c < n; c++) {
    eng.renderChunk(0, chunk);
    for (let i = 0; i < TRACKER_CHUNK; i++) out[c * TRACKER_CHUNK + i] = ts.mixLeft[i] + ts.mixRight[i];
  }
  setRandomSource(null);
  return out;
}

/** Median frequency of `x[a..z)`, searching periods within ±12 % of `f0`. */
export function trackPitch(x, a, z, f0) {
  const P0 = SAMPLING_RATE / f0;
  const lo = Math.floor(P0 / 1.12), hi = Math.ceil(P0 * 1.12);
  const W = Math.max(1024, Math.ceil(P0 * 8));
  const est = [];
  for (let s = a; s + W + hi < z; s += W >> 1) {
    const d = new Float64Array(hi + 2);
    for (let tau = lo - 1; tau <= hi + 1; tau++) {
      let acc = 0;
      for (let i = 0; i < W; i++) { const e = x[s + i] - x[s + i + tau]; acc += e * e; }
      d[tau] = acc;
    }
    let best = lo;
    for (let tau = lo; tau <= hi; tau++) if (d[tau] < d[best]) best = tau;
    const y0 = d[best - 1], y1 = d[best], y2 = d[best + 1];
    const den = y0 - 2 * y1 + y2;
    const frac = den > 0 ? (0.5 * (y0 - y2)) / den : 0;
    est.push(SAMPLING_RATE / (best + frac));
  }
  if (est.length === 0) return NaN;
  est.sort((p, q) => p - q);
  return est[est.length >> 1];
}

/** Cents error of `inst` playing each of `steps` (31-EDO steps), at volume `vol`. */
export function measureNotes(bank, inst, steps, vol = 50) {
  return measureWords(bank, inst, steps.map(noteWord), vol).map((r, i) => ({ ...r, step: steps[i] }));
}

/** Same, for raw note words. */
export function measureWords(bank, inst, words, vol = 50) {
  return words.map((word) => {
    const x = renderMono(heldNoteDoc(bank, inst, word, vol), 1.6);
    const a = Math.round(0.35 * SAMPLING_RATE), z = Math.round(1.5 * SAMPLING_RATE);
    const f = trackPitch(x, a, z, hzOf(word));
    return { word, cents: 1200 * Math.log2(f / hzOf(word)) };
  });
}
