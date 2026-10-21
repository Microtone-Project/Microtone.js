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
import * as IMX from "../core/engine/imix.js";

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
  // Item 217: a mixing chain with every piece of equipment in it on every
  // instrument, so the golden gate pins the chains' sound too — in stereo and
  // across an ambisonic scene.
  "Huygens_clock@imix": { file: "assets/demo_projects/Huygens_clock.taud", imix: true },
  "WHEN_AMBI@imix": { file: "assets/demo_projects/WHEN_AMBI.taud", imix: true },
};

/**
 * The chain the @imix variants install: every piece of equipment, a few
 * settings moved off their defaults so the multiband split, a dynamic band,
 * a retriggering LFO and the tempo-synced delay are all exercised. Instruments
 * alternate between two blocks, the second with the other pipeline order.
 */
export function goldenImixBlocks() {
  const make = (id, order) => {
    const b = IMX.defaultImixBlock(id);
    b.order = order;
    for (const eq of IMX.IMX_EQUIPMENT) b.equipment[eq] = IMX.defaultEquipment(eq);
    b.equipment.equ1.bands[1].gainDb = 3;
    b.equipment.equ2.bands[0] = { on: true, shape: IMX.IMX_EQ_HIGH_PASS, slope: 1, freq: 60, gainDb: 0, q: 0.7 };
    b.equipment.comp.bands = [IMX.defaultCompBand(), IMX.defaultCompBand(), IMX.defaultCompBand()];
    b.equipment.comp.crossovers = [180, 2400];
    b.equipment.comp.dry = 64;
    b.equipment.deq1.bands[3].on = true;
    b.equipment.deq2.bands[1] = { ...b.equipment.deq2.bands[1], on: true, unlinked: true, senseFreq: 300, boost: true };
    b.equipment.unis.detuneLfo = { wave: IMX.IMX_LFO_TRIANGLE, retrigger: true, sync: true, rate: 24 * IMX.FX16, depth: 0.5 };
    b.equipment.unis.widthLfo = { wave: IMX.IMX_LFO_RANDOM, retrigger: false, sync: false, rate: IMX.FX16, depth: 0.4 };
    b.equipment.satu.curve = IMX.IMX_SAT_TUBE;
    b.equipment.satu.bias = 0.1;
    b.equipment.dlay.pingPong = true;
    b.equipment.mxtl.width = 1.2;
    return b;
  };
  return [make(1, 0), make(2, 1)];
}

function installGoldenImix(eng) {
  eng.setImix(goldenImixBlocks());
  for (let s = 1; s < 1024; s++) eng.instruments[s].imixId = (s & 1) === 1 ? 1 : 2;
  eng.imixGen++;
}

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
    if (entry.imix) installGoldenImix(eng);
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
