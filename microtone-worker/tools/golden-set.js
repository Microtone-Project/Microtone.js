// The engine's golden set: which songs, rendered how, pin the reference
// behaviour of core/engine/ (see tools/make-golden.js, test/node/engine-golden.test.js).
//
// The web engine IS the reference implementation of the Taud engine — the TSVM
// Kotlin engine is downstream of it — so its own renders are what a refactor
// must reproduce bit for bit. Songs under test/corpus/ are local-only (that
// directory is gitignored), so their digests are checked where the file exists
// and skipped elsewhere; the bundled demo projects are tracked and always run.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../core/format/taud-parse.js";
import { TaudEngine } from "../core/engine/engine.js";
import { setSamplingRate } from "../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../core/engine/rng.js";
import { MONITOR_BINAURAL } from "../core/engine/binaural.js";
import { loadIntoEngine, renderSong } from "../core/audio/offline-render.js";

export const GOLDEN_RATE = 48000;   // the web engine's production rate (item 108)
export const GOLDEN_SECONDS = 20;
export const GOLDEN_SEED = 1;       // vol/pan swing + random LFO, made repeatable

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** label → { file (repo-relative), monitor? }. A label is what the JSON keys on. */
export const GOLDEN_SET = {
  "4THSYM": { file: "test/corpus/4THSYM.taud" },
  "changing_waves": { file: "test/corpus/changing_waves.taud" },
  "Circus galop": { file: "test/corpus/Circus galop.taud" },
  "flourish": { file: "test/corpus/flourish.taud" },
  "Insaniq2": { file: "test/corpus/Insaniq2.taud" },
  "M_E1M1": { file: "test/corpus/M_E1M1.taud" },
  "Onestop": { file: "test/corpus/Onestop.taud" },
  "slumberjack": { file: "test/corpus/slumberjack.taud" },
  "town": { file: "test/corpus/town.taud" },
  "WHEN": { file: "test/corpus/WHEN.taud" },
  "16uba_baion": { file: "assets/demo_projects/16uba_baion.taud" },
  "Temjin_speaki": { file: "assets/demo_projects/Temjin_speaki.taud" },
  "Huygens_clock": { file: "assets/demo_projects/Huygens_clock.taud" },
  "WHEN_AMBI": { file: "assets/demo_projects/WHEN_AMBI.taud" },
  "WHEN_AMBI@binaural": { file: "assets/demo_projects/WHEN_AMBI.taud", monitor: MONITOR_BINAURAL },
};

export function goldenPath(entry) { return ROOT + entry.file; }

const sha256 = (u8) => createHash("sha256").update(u8).digest("hex");

/** Render one golden entry; returns the digests the fixture records. */
export async function renderGolden(entry) {
  setSamplingRate(GOLDEN_RATE);
  setRandomSource(makeSeededRandom(GOLDEN_SEED));
  try {
    const doc = parseTaud(await readFile(goldenPath(entry)));
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    if (entry.monitor !== undefined) eng.setMonitorMode(0, entry.monitor);
    const r = renderSong(eng, GOLDEN_SECONDS);
    return {
      frames: r.frames,
      u8: sha256(r.u8),
      f32: sha256(new Uint8Array(r.f32.buffer, r.f32.byteOffset, r.f32.byteLength)),
    };
  } finally {
    setRandomSource(null);
  }
}
