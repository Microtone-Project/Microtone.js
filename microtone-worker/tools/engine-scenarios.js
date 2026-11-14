#!/usr/bin/env node
// The engine driven through everything a HOST does besides playing a file
// from the top: auditioning on the jam bank, the chase, starting at a row,
// the desk's faders, edits that land while notes are sounding, resets, the
// meters. Each scenario is a script; what it renders — the f32 mix bus and the
// 8-bit output — and everything the script notes along the way (the snapshot
// the page draws from, the readbacks) are digested, and the digests are the
// golden gate's second half (test/fixtures/engine-scenarios.json, checked by
// engine-golden.test.js). They were recorded when the C engine had been shown
// identical, scenario for scenario, to the JavaScript engine it replaced; the
// meter scenarios held again when the meters moved into it (meters.c).
//
//   node tools/engine-scenarios.js [scenario …]          check
//   node tools/engine-scenarios.js --write [scenario …]  re-record
//
// Every number recorded is the engine's own (it carries its own pow), so the
// digests are the same bits on every machine. A deliberate change to what a
// host hears or reads re-records the scenarios it moved, in the same batch,
// saying which.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../core/format/taud-parse.js";
import { WasmTaudEngine } from "../core/engine/wasm-engine.js";
import {
  TaudInst, parsePatchesBlob, buildMetaRecord, makeMetaLayer, META_TYPE_FM, FM_WORD_OSC, FM_WORD_MOD, FM_WORD_FB, FmOp,
} from "../core/engine/inst.js";
import { pitchExtEntry, buildPitchExtSection } from "../core/format/pitch-ext-section.js";
import { setSamplingRate, TRACKER_CHUNK, SAMPLE_BIN_TOTAL } from "../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../core/engine/rng.js";
import { loadIntoEngine } from "../core/audio/offline-render.js";
import { fillSnapshotInto } from "../core/worklet/engine-commands.js";
import { goldenImixBlocks } from "./golden-set.js";
import { normaliseMastering } from "../core/engine/mastering.js";
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
  "the Mastering view metering a chain that works hard": {
    file: DEMO("16uba_baion"),
    script(r) {
      const { eng } = r;
      r.taps = true;
      const chain = (over) => normaliseMastering({
        on: true, trimDb: 9, hpOn: true, hpFreq: 60, hpSlope: 1, eqOn: true,
        eq: [
          { on: true, type: 0, freq: 120, gainDb: 4, q: 0.7 },
          { on: true, type: 1, freq: 500, gainDb: -3, q: 1.4 },
          { on: false, type: 1, freq: 2500, gainDb: 6, q: 1 },
          { on: true, type: 2, freq: 9000, gainDb: 5, q: 0.7 },
        ],
        compOn: true, compDetector: 1, compThreshDb: -24, compRatio: 6, compAttackMs: 3,
        compReleaseMs: 120, compKneeDb: 8, compMakeupDb: 4,
        widthOn: true, width: 1.6,
        limOn: true, limTruePeak: true, limCeilingDb: -1.5, limReleaseMs: 60, outGainDb: 1,
        ...over,
      });
      eng.setMastering(0, chain({}));
      eng.setAnalysis(0, "stereo");
      eng.setMasterMeter(0, true, true, 16, 2);
      playFromTop(r);
      r.render(300);
      eng.setMasterMeter(0, true, true, 8, 2);
      eng.setMastering(0, chain({ compDetector: 0, limTruePeak: false, hpSlope: 0, width: 0.4 }));
      r.render(200);
      eng.setMasterMeter(0, true, false, 16, 1);
      eng.setMastering(0, chain({ trimDb: 18, compOn: false }));   // the limiter alone, driven
      r.render(200);
      eng.setMasterMeter(0, true, true, 16, 0);
      eng.resetParams(0);
      r.render(60);
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
  "pitch extensions installed, outdated by an edit, and taken away": {
    file: DEMO("Huygens_clock"),
    script(r) {
      const { eng, doc } = r;
      // An `IPit` section over the song's own bank (§9.18): every instrument's
      // base detune, every layer and every zone moved off the 4096-TET grid,
      // and one layer table reaching for another sixteen octaves.
      const image = doc.sampleInstImage;
      const recOf = (slot) => image.subarray(SAMPLE_BIN_TOTAL + slot * 256, SAMPLE_BIN_TOTAL + (slot + 1) * 256);
      const blobs = new Map(doc.ixmp.map((e) => [e.instId, e.blob]));
      const entries = [];
      let tables = 0, first = -1;
      for (let slot = 1; slot < 1024; slot++) {
        const m = new TaudInst(slot);
        m.loadRecord(recOf(slot));
        if (blobs.has(slot)) m.extraPatches = parsePatchesBlob(blobs.get(slot));
        const tabled = m.metaLayers !== null;
        if (!tabled && m.sampleLength === 0 && m.extraPatches === null) continue;
        if (first < 0 && !tabled) first = slot;
        const n = m.extraPatches?.length ?? 0;
        entries.push(pitchExtEntry(m, {
          base: tabled ? null : [0x05, 0x02, 0],
          table: tabled ? Array.from({ length: m.metaEntryCount * 3 }, (_, i) => (i % 3 === 0 ? (tables++ === 0 ? 0x13 : 0x0b) : i % 3 === 2 ? 0x04 : 0)) : null,
          patches: n > 0 ? Array.from({ length: n * 3 }, (_, i) => (i % 3 === 2 ? 0x07 : 0)) : null,
        }));
      }
      const section = buildPitchExtSection(entries);
      r.note(entries.length, section.length);
      playFromTop(r);
      r.render(200);
      eng.setPitchExt(section);             // under sounding notes
      r.render(400);
      // An edit the section does not know of: that instrument's entry is
      // outdated, and the rest stand.
      const changed = Uint8Array.from(recOf(first));
      changed[184] ^= 0x10;
      eng.uploadInstrument(first, changed);
      r.render(200);
      eng.uploadInstrument(first, recOf(first));
      eng.setTrackerRow(0, 0);
      eng.play(0);
      r.render(300);
      eng.setPitchExt(null);
      r.render(200);
    },
  },
  "FM racks at their own rate: feedback, a filtered modulator, chip operators, ghosts": {
    file: DEMO("Troll_Chord"),
    script(r) {
      const { eng, doc } = r;
      // Racks built over the song's own bank (§5.5.1): the demo has none, and
      // a rack's sub-steps, its low-pass, an operator's filter at the rack's
      // rate and a chip operator held over a frame are all the engine's.
      const image = doc.sampleInstImage;
      const recOf = (slot) => image.subarray(SAMPLE_BIN_TOTAL + slot * 256, SAMPLE_BIN_TOTAL + (slot + 1) * 256);
      const kindOf = (slot) => { const b = recOf(slot); return b[2] === 0xff && b[3] === 0xff ? b[0] >> 4 : -1; };
      const used = r.usedInstruments();
      const opl = used.find((s) => kindOf(s) === 8), psg = used.find((s) => kindOf(s) === 9);
      // A one-cycle oscillator of our own, and the same with a filter on it:
      // the Impulse Tracker kind, then the SoundFont one with a resonance.
      // (Written into a copy of the song's image, which goes up whole — the
      // way a host changes the pool — with the patch lists after it.)
      const bank = Uint8Array.from(image);
      const at = 0x7f0000;
      for (let i = 0; i < 256; i++) bank[at + i] = 128 + Math.round(110 * Math.sin((2 * Math.PI * i) / 256) + 14 * Math.sin((6 * Math.PI * i) / 256));
      eng.uploadSampleInstBlob(bank);
      for (const e of doc.ixmp) eng.uploadInstrumentPatches(e.instId, e.blob);
      const osc = (cut = 0xff, sf = false) => {
        const b = new Uint8Array(256);
        b[0] = at & 0xff; b[1] = (at >> 8) & 0xff; b[2] = (at >> 16) & 0xff;
        b[4] = 0; b[5] = 1; b[6] = 0x00; b[7] = 0x80; b[12] = 0; b[13] = 1; b[14] = 1;
        b[21] = 0x3f; b[171] = 255; b[196] = 255;
        if (sf) { b[173] = 0x10; b[182] = 0x24; b[252] = 0x9c; b[183] = 0x00; b[253] = 0x50; } // 9372 cents (1.84 kHz), 8 dB
        else { b[182] = cut; b[183] = 0x40; }
        return b;
      };
      eng.uploadInstrument(940, osc());
      eng.uploadInstrument(941, osc(0x58));
      eng.uploadInstrument(942, osc(0, true));
      const L = (inst, octet, detune, fixed = false) => makeMetaLayer(inst, octet, detune, 0x0000, 0xffff, 0, 63, fixed);
      const rack = (ops, program) => buildMetaRecord(ops, { type: META_TYPE_FM, program: Uint16Array.from([...program, FmOp.END]) });
      // 950: a carrier with a modulator that feeds itself back.
      eng.uploadInstrument(950, rack([L(940, 159, 0), L(940, 175, 4096)], [FM_WORD_FB | 1, FM_WORD_MOD | 1, FM_WORD_MOD | 0]));
      // 951: three in series, the two modulators filtered (one each way), the top one fixed.
      eng.uploadInstrument(951, rack([L(940, 159, 0), L(941, 190, 6492), L(942, 200, 0x6800, true)],
        [FM_WORD_OSC | 2, FM_WORD_MOD | 1, FM_WORD_MOD | 0]));
      // 952 / 953: a chip as the modulator, and as the carrier.
      eng.uploadInstrument(952, rack([L(940, 159, 0), L(opl, 180, 0)], [FM_WORD_OSC | 1, FM_WORD_MOD | 0]));
      eng.uploadInstrument(953, rack([L(psg, 159, 0), L(940, 185, 4096)], [FM_WORD_OSC | 1, FM_WORD_MOD | 0]));
      r.note(opl, psg);
      let k = 0;
      for (const inst of [950, 951, 952, 953]) {
        for (const note of [0x3800, 0x5000, 0x6955, 0x8400]) {
          eng.jamNote(0, eng.jamVoice(k++ % 6), note, inst, false);
          r.render(90);
        }
        eng.jamRelease(0, eng.jamVoice((k + 3) % 6));
        r.render(60);
      }
      // …and under a song, on lanes, where a new note ghosts the old rack.
      playFromTop(r);
      for (let i = 0; i < 6; i++) {
        eng.jamNote(0, 30, 0x4800 + i * 0x2ab, 950 + (i & 1), false);
        r.render(50);
      }
      eng.jamStop(0);
      r.render(120);
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

function runScenario(scenario) {
  setSamplingRate(RATE);
  setRandomSource(makeSeededRandom(1));
  try {
    const doc = parseTaud(readFileSync(ROOT + scenario.file));
    const eng = new WasmTaudEngine(RATE);
    loadIntoEngine(eng, doc, 0);
    const run = new Run(eng, doc);
    scenario.script(run);
    return run;
  } finally {
    setRandomSource(null);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** One scenario's digests: { chunks, f32, u8, notes, peak }. */
export function digestScenario(scenario) {
  const r = runScenario(scenario);
  const f32 = createHash("sha256"), u8 = createHash("sha256");
  let peak = 0;
  for (const f of r.f32) {
    f32.update(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
    for (let i = 0; i < f.length; i++) { const v = Math.abs(f[i]); if (v > peak) peak = v; }
  }
  for (const b of r.u8) u8.update(b);
  return {
    chunks: r.f32.length,
    f32: f32.digest("hex"),
    u8: u8.digest("hex"),
    notes: sha256(r.notes.map((v) => (typeof v === "number" ? (Object.is(v, -0) ? "-0" : String(v)) : JSON.stringify(v))).join("\n")),
    // A scenario that renders silence proves nothing: how loud it got.
    peak: Math.round(peak * 1000) / 1000,
  };
}

export const SCENARIO_FIXTURE = fileURLToPath(new URL("../test/fixtures/engine-scenarios.json", import.meta.url));

/** The scenarios present on this machine (their files exist), by name. */
export function scenarioNames() {
  return Object.keys(SCENARIOS).filter((n) => existsSync(ROOT + SCENARIOS[n].file));
}

export function scenarioByName(name) { return SCENARIOS[name]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const names = args.filter((a) => a !== "--write");
  let fixture = { rate: RATE, scenarios: {} };
  try { fixture = JSON.parse(readFileSync(SCENARIO_FIXTURE, "utf8")); } catch { /* first run */ }
  let bad = 0;
  for (const name of scenarioNames()) {
    if (names.length && !names.includes(name)) continue;
    const d = digestScenario(SCENARIOS[name]);
    const prev = fixture.scenarios[name];
    const moved = !prev || prev.f32 !== d.f32 || prev.u8 !== d.u8 || prev.notes !== d.notes || prev.chunks !== d.chunks;
    if (write) fixture.scenarios[name] = { file: SCENARIOS[name].file, ...d };
    else if (moved) bad++;
    console.log(`${name}: ${prev ? (moved ? "CHANGED" : "unchanged") : "new"} (${d.chunks} chunks, peak ${d.peak})`);
  }
  if (write) {
    writeFileSync(SCENARIO_FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`wrote ${SCENARIO_FIXTURE}`);
  } else if (bad) {
    console.error(`\n${bad} scenario(s) differ from the fixture`);
    process.exit(1);
  }
}
