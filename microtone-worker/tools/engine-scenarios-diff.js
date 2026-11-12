#!/usr/bin/env node
// The JavaScript engine against the C engine built as WebAssembly, driven
// through everything a HOST does besides playing a file from the top:
// auditioning on the jam bank, the chase, starting at a row, the desk's
// faders, edits that land while notes are sounding, resets. Each scenario is
// a script run on one engine and then on the other; what they render — the
// f32 mix bus and the 8-bit output — and everything the script notes along
// the way must be the same.
//
//   node --no-use-std-math-pow tools/engine-scenarios-diff.js [scenario …]
//
// The flag is tools/engine-diff.js's: it makes V8 compute the pow the C
// engine carries, and only then is "the same" exact. Exits 1 on a difference.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../core/format/taud-parse.js";
import { TaudEngine } from "../core/engine/engine.js";
import { WasmTaudEngine } from "../core/engine/wasm-engine.js";
import { TaudInst } from "../core/engine/inst.js";
import { setSamplingRate, TRACKER_CHUNK, SAMPLE_BIN_TOTAL } from "../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../core/engine/rng.js";
import { loadIntoEngine } from "../core/audio/offline-render.js";
import { fillSnapshotInto } from "../core/worklet/engine-commands.js";
import { goldenImixBlocks } from "./golden-set.js";
import {
  SNAP_FLOATS, SNAP_AN_METERS, SNAP_HEADER_SIZE, SNAP_METER_BASE,
  SNAP_EP_BASE, SNAP_EP_COUNT, SNAP_EP_ENTRIES, SNAP_EP_STRIDE, SNAP_INTERRUPT_ARGS, SNAP_IM_BASE,
} from "../core/worklet/protocol.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RATE = 48000;
const DEMO = (name) => `assets/demo_projects/${name}.taud`;

/** What a scenario's script is handed: the engine, the parsed file, and a
 *  recorder for the PCM it renders and the values it wants compared. */
class Run {
  constructor(eng, doc) {
    this.eng = eng;
    this.doc = doc;
    this.f32 = [];
    this.u8 = [];
    this.notes = [];
    this.chunk = new Uint8Array(TRACKER_CHUNK * 2);
    this.snap = new Float32Array(SNAP_FLOATS);
    this.taps = false;
  }

  /** Render `n` chunks whatever the transport says (a host renders while
   *  playing OR jamming); the playhead is noted every chunk. */
  render(n) {
    const eng = this.eng;
    const ts = eng.playheads[0].trackerState;
    for (let i = 0; i < n; i++) {
      eng.renderChunk(0, this.chunk);
      this.u8.push(this.chunk.slice());
      const f = new Float32Array(TRACKER_CHUNK * 2);
      f.set(ts.mixLeft, 0);
      f.set(ts.mixRight, TRACKER_CHUNK);
      this.f32.push(f);
      this.notes.push((eng.isPlaying(0) ? 1 : 0) | (eng.playheads[0].jamActive ? 2 : 0),
        eng.getCuePosition(0), eng.getTrackerRow(0), eng.getBPM(0), eng.getTickRate(0),
        eng.getSongGlobalVolume(0));
      // Every fourth chunk, what the page would draw from: the snapshot's
      // playhead, voice and envelope-playhead blocks, and the readbacks.
      if ((this.f32.length & 3) === 0) this.snapshot();
    }
  }

  snapshot() {
    const eng = this.eng;
    const f = this.snap;
    // The host's own snapshot path: for the WebAssembly engine it calls the
    // engine's writer and then drains the same taps.
    fillSnapshotInto(eng, 0, f);
    for (let i = 0; i < SNAP_AN_METERS; i++) this.notes.push(f[i]);
    for (let i = SNAP_HEADER_SIZE; i < SNAP_METER_BASE; i++) this.notes.push(f[i]);
    const n = f[SNAP_EP_COUNT];
    for (let i = SNAP_EP_BASE; i < SNAP_EP_ENTRIES + n * SNAP_EP_STRIDE; i++) this.notes.push(f[i]);
    // With a tap on, its whole block: the strip's meters and scope ring, the
    // Mastering view's levels, histogram and rings.
    if (this.taps) {
      for (let i = SNAP_AN_METERS; i < SNAP_INTERRUPT_ARGS; i++) this.notes.push(f[i]);
      for (let i = SNAP_METER_BASE; i < SNAP_EP_BASE; i++) this.notes.push(f[i]);
    }
    const counts = eng.getActiveNoteCounts(0);
    for (let slot = 0; slot < 1024; slot++) {
      if (counts[slot] === 0) continue;
      this.notes.push(slot, counts[slot]);
      this.notes.push(...eng.getInstrumentInvertMask(slot), -1, ...eng.getInstrumentModMask(slot), -1);
      for (const v of Object.values(eng.getInstrumentSampleMod(slot))) this.notes.push(Number(v));
      this.notes.push(JSON.stringify(eng.getInstrumentPsgState(slot)));
      this.notes.push(JSON.stringify(eng.getInstrumentFormantState(slot)));
    }
  }

  note(...values) { this.notes.push(...values); }

  /** The instrument slots whose record is not blank, ascending. */
  usedInstruments() {
    const image = this.doc.sampleInstImage;
    const out = [];
    for (let s = 1; s < 1024; s++) {
      const o = SAMPLE_BIN_TOTAL + s * 256;
      if (o + 256 > image.length) break;
      let any = false;
      for (let k = 0; k < 256 && !any; k++) any = image[o + k] !== 0;
      if (any) out.push(s);
    }
    return out;
  }

  record(slot) {
    const o = SAMPLE_BIN_TOTAL + slot * 256;
    return this.doc.sampleInstImage.slice(o, o + 256);
  }
}

function playFromTop(r) {
  r.eng.setCuePosition(0, 0);
  r.eng.setTrackerRow(0, 0);
  r.eng.play(0);
}

/** name → { file, script(run) }. */
export const SCENARIOS = {
  "play: Daisy_bell (lyrics + chains)": {
    file: DEMO("Daisy_bell"),
    script(r) { playFromTop(r); r.render(3000); },
  },
  "play: Troll_Chord": {
    file: DEMO("Troll_Chord"),
    script(r) { playFromTop(r); r.render(3000); },
  },
  "play: every song of WHEN_AMBI": {
    file: DEMO("WHEN_AMBI"),
    script(r) {
      for (let s = 1; s < r.doc.songs.length; s++) {
        r.eng.resetParams(0);
        loadIntoEngine(r.eng, r.doc, s);
        playFromTop(r);
        r.render(700);
        r.eng.stop(0);
      }
    },
  },
  "jam on a stopped transport": {
    file: DEMO("Huygens_clock"),
    script(r) {
      const { eng } = r;
      const insts = r.usedInstruments();
      for (let k = 0; k < Math.min(8, insts.length); k++) {
        eng.jamNote(0, eng.jamVoice(k), 0x5000 + k * 0x155, insts[k], k % 2 === 1);
        r.render(40);
      }
      r.render(150);
      eng.jamKeyOff(0, eng.jamVoice(0));
      eng.jamRelease(0, eng.jamVoice(1));
      eng.jamStopVoice(0, eng.jamVoice(2));
      r.render(150);
      eng.jamStopVoice(0, -1);
      let spins = 0;
      while (eng.playheads[0].jamActive && spins < 800) { r.render(1); spins++; }
      r.note(spins);
      // …a lane voice auditioned (note entry lands on the lane it is typed in)
      eng.jamNote(0, 3, 0x5800, insts[0], false);
      r.render(120);
      eng.jamStop(0);
      r.render(4);
    },
  },
  "jam every instrument of 16uba_baion": {
    file: DEMO("16uba_baion"),
    script(r) {
      const { eng } = r;
      const insts = r.usedInstruments();
      let k = 0;
      for (const inst of insts) {
        eng.jamNote(0, eng.jamVoice(k++), 0x4000 + ((inst * 0x1d3) & 0x3fff), inst, true);
        r.render(12);
        if (k % 5 === 0) eng.jamRelease(0, eng.jamVoice(k - 3));
      }
      r.render(200);
    },
  },
  "jam a lyric instrument": {
    file: DEMO("Daisy_bell"),
    script(r) {
      const { eng, doc } = r;
      const inst = doc.lyrics[0].instId & 0x3ff;
      for (let k = 0; k < 9; k++) {
        eng.jamNote(0, eng.jamVoice(k), 0x5000 + (k % 5) * 0x200, inst, true);
        r.render(90);
        eng.jamRelease(0, eng.jamVoice(k));
        r.render(30);
      }
      r.render(300);
    },
  },
  "jam the formant voices of Temjin_speaki": {
    file: DEMO("Temjin_speaki"),
    script(r) {
      const { eng } = r;
      const insts = r.usedInstruments();
      let k = 0;
      for (const inst of insts.slice(0, 24)) {
        eng.jamNote(0, eng.jamVoice(k), 0x5400, inst, true);
        r.render(60);
        if (k % 2) eng.jamRelease(0, eng.jamVoice(k)); else eng.jamKeyOff(0, eng.jamVoice(k));
        r.render(20);
        k++;
      }
      r.render(200);
    },
  },
  "jam over playback, stop, play again": {
    file: DEMO("Zeta_valley"),
    script(r) {
      const { eng } = r;
      const insts = r.usedInstruments();
      playFromTop(r);
      r.render(260);
      eng.jamNote(0, eng.jamVoice(0), 0x5000, insts[0], true);
      eng.jamNote(0, eng.jamVoice(1), 0x5555, insts[1], true);
      r.render(60);
      eng.stop(0);
      r.render(220);
      eng.jamNote(0, eng.jamVoice(2), 0x4c00, insts[2], true);
      r.render(30);
      eng.play(0);
      r.render(200);
      eng.stop(0);
      r.render(8);
    },
  },
  "jam a pooled sample, mono and as a pair": {
    file: DEMO("Huygens_clock"),
    script(r) {
      const { eng } = r;
      const specs = [];
      for (const slot of r.usedInstruments()) {
        const inst = new TaudInst(slot);
        inst.loadRecord(r.record(slot));
        if (inst.isMeta || inst.sampleLength <= 0) continue;
        specs.push({
          ptr: inst.samplePtr, len: inst.sampleLength, rate: inst.samplingRate,
          playStart: inst.samplePlayStart, loopStart: inst.sampleLoopStart, loopEnd: inst.sampleLoopEnd,
          loopMode: inst.loopMode, detune: inst.sampleDetune,
        });
        if (specs.length === 4) break;
      }
      r.note(specs.length);
      specs.forEach((spec, k) => {
        eng.jamSample(0, eng.jamVoice(k), 0x5000, spec);
        r.render(80);
      });
      if (specs.length >= 2) {
        eng.jamSample(0, eng.jamVoice(5), 0x5000, { ...specs[0], chanPtr2: specs[1].ptr, chanMode: 0 });
        r.render(120);
        eng.jamSample(0, eng.jamVoice(6), 0x4c00, { ...specs[1], chanPtr2: specs[0].ptr, chanMode: 1 });
        r.render(120);
      }
      eng.jamStopVoice(0, -1);
      r.render(40);
    },
  },
  "chase to a row": {
    file: DEMO("Huygens_clock"),
    script(r) {
      const { eng } = r;
      for (const [cue, row] of [[1, 0], [3, 17], [6, 63], [9, 32], [15, 5], [400, 0]]) {
        r.note(eng.chaseTrackerRow(0, cue, row) ? 1 : 0);
        eng.play(0);
        r.render(220);
        eng.stop(0);
      }
    },
  },
  "chase through Zeta_valley and Temjin_speaki": {
    file: DEMO("Zeta_valley"),
    script(r) {
      const { eng } = r;
      for (const [cue, row] of [[2, 8], [11, 40], [30, 0], [43, 60]]) {
        r.note(eng.chaseTrackerRow(0, cue, row) ? 1 : 0);
        eng.play(0);
        r.render(260);
        eng.stop(0);
      }
      const temjin = parseTaud(readFileSync(ROOT + DEMO("Temjin_speaki")));
      eng.resetParams(0);
      loadIntoEngine(eng, temjin, 0);
      for (const [cue, row] of [[4, 0], [20, 33], [60, 12]]) {
        r.note(eng.chaseTrackerRow(0, cue, row) ? 1 : 0);
        eng.play(0);
        r.render(260);
        eng.stop(0);
      }
    },
  },
  "start at a row without chasing": {
    file: DEMO("16uba_baion"),
    script(r) {
      const { eng } = r;
      for (const [cue, row] of [[0, 0], [5, 20], [12, 63], [30, 1]]) {
        eng.setCuePosition(0, cue);
        eng.setTrackerRow(0, row);
        eng.play(0);
        r.render(240);
        eng.stop(0);
        r.render(2);
      }
    },
  },
  "the desk: faders and mutes under playback": {
    file: DEMO("Huygens_clock"),
    script(r) {
      const { eng } = r;
      playFromTop(r);
      for (let step = 0; step < 24; step++) {
        r.render(35);
        const lane = (step * 5) % 12;
        if (step % 3 === 0) eng.setVoiceMute(0, lane, step % 2 === 0);
        else eng.setVoiceFader(0, lane, (step * 37) & 255);
        r.note(eng.getVoiceFader(0, lane), eng.getVoiceMute(0, lane) ? 1 : 0);
      }
      r.render(60);
    },
  },
  "the song's parameters moved under playback": {
    file: DEMO("WHEN_AMBI"),
    script(r) {
      const { eng } = r;
      playFromTop(r);
      r.render(150);
      eng.setBPM(0, 171); r.render(80);
      eng.setTickRate(0, 4); r.render(80);
      eng.setSongGlobalVolume(0, 90); r.render(40);
      eng.setSongMixingVolume(0, 200); r.render(40);
      eng.setMasterVolume(0, 180); r.render(40);
      eng.setTuning(0, 0x5000, 432); r.render(80);
      eng.setMonitorMode(0, 1); r.render(120);
      eng.setMonitorMode(0, 0); r.render(80);
      eng.setTrackerMixerFlags(0, 0x0c); r.render(80);
      eng.setMasterPan(0, 60); r.render(40);
    },
  },
  "an instrument re-uploaded while its notes sound": {
    file: DEMO("Huygens_clock"),
    script(r) {
      const { eng, doc } = r;
      const insts = r.usedInstruments();
      playFromTop(r);
      r.render(180);
      // every used record again, some with a byte moved (the instrument's
      // global volume sits at byte 20 of an ordinary record)
      insts.forEach((slot, k) => {
        const rec = r.record(slot);
        if (k % 3 === 0) rec[20] = Math.max(1, rec[20] >> 1);
        eng.uploadInstrument(slot, rec);
        if (k % 4 === 0) r.render(6);
      });
      r.render(160);
      // the extra patches again, then gone, then back
      for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
      r.render(100);
      for (const entry of doc.ixmp.slice(0, 5)) eng.clearInstrumentPatches(entry.instId);
      r.note(...doc.ixmp.slice(0, 8).map((e) => eng.getInstrumentPatchCount(e.instId)));
      r.render(100);
      // the whole image again (which drops every patch), and the patches after it
      eng.uploadSampleInstBlob(doc.sampleInstImage);
      r.render(60);
      for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
      r.render(200);
    },
  },
  "patches and records re-uploaded hundreds of times under playback": {
    // Enough replaced data for the engine to sweep its retired list many times
    // while voices are still reading the patches it holds (the WebAssembly
    // engine's stand-in for the garbage collector).
    file: DEMO("16uba_baion"),
    script(r) {
      const { eng, doc } = r;
      const insts = r.usedInstruments();
      playFromTop(r);
      r.render(120);
      for (let round = 0; round < 40; round++) {
        for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
        if (round % 4 === 1) for (const slot of insts) eng.uploadInstrument(slot, r.record(slot));
        if (round % 10 === 5) {
          eng.uploadSampleInstBlob(doc.sampleInstImage);
          for (const entry of doc.ixmp) eng.uploadInstrumentPatches(entry.instId, entry.blob);
        }
        r.render(14);
      }
      r.render(120);
    },
  },
  "the master strip and the Mastering view metering a song": {
    file: DEMO("Daisy_bell"),
    script(r) {
      const { eng } = r;
      r.taps = true;
      eng.setAnalysis(0, "stereo");
      eng.setMasterMeter(0, true, true, 16, 0);
      playFromTop(r);
      r.render(260);
      eng.setMasterMeter(0, true, false, 8, 1);
      r.render(160);
      eng.setTrackerRow(0, 0);   // the meters' integration starts again with the play
      eng.play(0);
      r.render(120);
      eng.setAnalysis(0, "off");
      eng.setMasterMeter(0, false);
      r.render(40);
      eng.setAnalysis(0, "stereo");
      r.render(80);
    },
  },
  "the master strip metering a surround song, field and speakers": {
    file: DEMO("WHEN_AMBI"),
    script(r) {
      const { eng } = r;
      r.taps = true;
      eng.setAnalysis(0, "ambisonic");
      playFromTop(r);
      r.render(200);
      for (const target of ["5.1", "7.1", "quad", "stereo", "ambisonic"]) {
        eng.setAnalysis(0, target);
        r.render(120);
      }
      eng.setMonitorMode(0, 1);   // binaural monitor: the analysis bus is its own
      r.render(120);
      eng.setAnalysis(0, "off");
      r.render(20);
      // …and a song of another model under a tap that is already on
      eng.setAnalysis(0, "7.1");
      eng.resetParams(0);
      loadIntoEngine(eng, r.doc, 2);
      playFromTop(r);
      r.render(200);
    },
  },
  "the Mixing tab's meters on two instruments' chains": {
    file: DEMO("Zeta_valley"),
    script(r) {
      const { eng, doc } = r;
      r.taps = true;
      // The instruments that name a chain, from byte 255 of their records.
      const chained = r.usedInstruments().filter((slot) => r.record(slot)[255] !== 0);
      r.note(chained.length);
      eng.setImixMeter(0, chained[0], 0);
      eng.setImixMeter(0, chained[chained.length - 1], 1);
      playFromTop(r);
      r.render(400);
      eng.setImixMeter(0, chained[0], 1);      // both seats on one bus
      r.render(200);
      eng.setImix(goldenImixBlocks(true, true, true)); // every piece of equipment, in bus mode
      for (const slot of chained) eng.setInstrumentImixId(slot, (slot & 1) + 1);
      r.render(300);
      eng.setTrackerRow(0, 0);
      eng.play(0);
      r.render(120);
      eng.setImixMeter(0, -1, 0);
      r.render(60);
      eng.setImix(doc.imix);
      r.render(60);
    },
  },
  "chains, mastering and lyrics pushed again under playback": {
    file: DEMO("Daisy_bell"),
    script(r) {
      const { eng, doc } = r;
      playFromTop(r);
      r.render(300);
      eng.setLyrics(doc.lyrics);
      r.render(200);
      eng.setImix(doc.imix);
      r.render(200);
      eng.setImix([]);
      r.render(100);
      eng.setImix(doc.imix);
      eng.setMastering(0, null);
      r.render(100);
      eng.setMastering(0, doc.songs[0].mastering ?? doc.meta?.mastering?.[0] ?? null);
      eng.setLyrics([]);
      r.render(200);
      eng.setLyrics(doc.lyrics);
      r.render(200);
    },
  },
  "a full reset and a second file": {
    file: DEMO("Zeta_valley"),
    script(r) {
      const { eng } = r;
      playFromTop(r);
      r.render(200);
      eng.resetParams(0);
      r.note(eng.getBPM(0), eng.getTickRate(0), eng.isPlaying(0) ? 1 : 0);
      r.render(3);
      const second = parseTaud(readFileSync(ROOT + DEMO("16uba_baion")));
      loadIntoEngine(eng, second, 0);
      eng.resetSampleFxState(0);
      playFromTop(r);
      r.render(300);
    },
  },
};

function runScenario(scenario, kind) {
  setSamplingRate(RATE);
  setRandomSource(makeSeededRandom(1));
  try {
    const doc = parseTaud(readFileSync(ROOT + scenario.file));
    const eng = kind === "wasm" ? new WasmTaudEngine(RATE) : new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    const run = new Run(eng, doc);
    scenario.script(run);
    return run;
  } finally {
    setRandomSource(null);
  }
}

/** Compare one scenario's two runs; null when they agree, else what differs. */
function compare(a, b) {
  if (a.f32.length !== b.f32.length) return `rendered ${a.f32.length} chunks against ${b.f32.length}`;
  for (let c = 0; c < a.f32.length; c++) {
    const x = a.f32[c], y = b.f32[c];
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i] && !(x[i] !== x[i] && y[i] !== y[i])) {
        return `f32 differs at chunk ${c}, ${i < TRACKER_CHUNK ? "left" : "right"} frame ${i % TRACKER_CHUNK}: ${x[i]} against ${y[i]}`;
      }
    }
    const p = a.u8[c], q = b.u8[c];
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return `u8 differs at chunk ${c}, byte ${i}`;
  }
  if (a.notes.length !== b.notes.length) return `noted ${a.notes.length} values against ${b.notes.length}`;
  for (let i = 0; i < a.notes.length; i++) {
    if (a.notes[i] !== b.notes[i]) return `noted value ${i} is ${a.notes[i]} against ${b.notes[i]}`;
  }
  return null;
}

export function diffScenarios(names = [], log = () => {}) {
  let bad = 0, ran = 0;
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (names.length && !names.includes(name)) continue;
    if (!existsSync(ROOT + scenario.file)) { log(`${name}: ${scenario.file} is not on this machine`); continue; }
    const js = runScenario(scenario, "js");
    const wasm = runScenario(scenario, "wasm");
    const diff = compare(js, wasm);
    ran++;
    if (diff !== null) bad++;
    // A scenario that renders silence proves nothing: say how loud it got.
    let peak = 0;
    for (const f of js.f32) for (let i = 0; i < f.length; i++) { const v = Math.abs(f[i]); if (v > peak) peak = v; }
    log(`${name}: ${diff === null ? "identical" : diff} (${js.f32.length} chunks, peak ${peak.toFixed(3)})`);
  }
  return { ran, bad };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ran, bad } = diffScenarios(process.argv.slice(2), console.log);
  if (!process.execArgv.includes("--no-use-std-math-pow")) {
    console.log("\nMath.pow here is the platform's; run with node --no-use-std-math-pow for the exact comparison.");
  }
  if (bad) {
    console.error(`\n${bad} of ${ran} scenarios differ`);
    process.exit(1);
  }
  console.log(`\n${ran} scenarios compared, none differ`);
}
