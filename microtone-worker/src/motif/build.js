// Motif's build: a TML source → a whole Taud project (Document). The same
// pipeline in the app and on the command line, byte for byte; only how the
// soundfont bank is made differs, so the host hands that step in.
//
//   evaluate     run the program (sandboxed) → the score
//   compile      the score → patterns, cues, pattern names (compile.js)
//   bank         the instruments' soundfont presets → a .tsii, made by the
//                app's own SF2 driver (sf2bank.py) at the song's tempo
//   assemble     bank + song + texts + notation + master → a Document
//   instruments  layer choice, New Note Action and fadeout overrides
//   cleanup      every Ixmp zone no note can reach is pruned, as the app's
//                Housekeeping does (and every instrument nothing plays, when
//                a `layers` option left some behind)
//   tweak        minimum fadeouts, layer gains
//   retune       every zone the song plays, measured and moved onto the grid
//   source       the TML itself, saved in the project (PMtf) so it can be
//                opened, changed and rebuilt

import { parseTaud } from "../../core/format/taud-parse.js";
import { buildMasteringSection } from "../../core/format/mastering-section.js";
import { defaultMastering } from "../../core/engine/mastering.js";
import { parsePatchesBlob, writePatchesBlob, buildMetaRecord } from "../../core/engine/inst.js";
import { SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { Document } from "../doc/document.js";
import { planIxmpCleanup, planBankCleanup, encodeNameTable } from "../doc/cleanup.js";
import { cleanupBankOp } from "../doc/ops.js";
import { buildIxmpSection } from "../doc/bankmerge.js";
import { MotifError } from "./lexer.js";
import { parse } from "./parser.js";
import { Interp } from "./interp.js";
import { stdlib } from "./stdlib.js";
import { Score, musicBuiltins, musicHooks, dbOctet } from "./music.js";
import { compileScore } from "./compile.js";
import { retune } from "./retune.js";

/** The project section a Motif build keeps its source in. */
export const MOTIF_FOURCC = "PMtf";
/** The soundfont a song plays from when it names none: the one the app bundles. */
export const BUNDLED_SOUNDFONT = "GeneralUser GS";

/**
 * Run a TML program. Returns the Score; throws a MotifError (with the line and
 * column) for anything wrong with it.
 * @param opts.steps  the step budget (default 50 million)
 * @param opts.log    print()'s output, a line at a time
 */
export function evaluate(source, opts = {}) {
  const score = interpret(source, opts);
  if (!score.song) throw new MotifError("the file declares no song: write song { … } after tml 1", { line: 1, col: 1 });
  if (!score.instruments.length) throw new MotifError("the song has no instruments: declare one with instrument NAME { bank: …, program: … }", { line: 1, col: 1 });
  if (!score.lanes.length) throw new MotifError("the song has no lanes: declare one with lane NAME { inst: … }", { line: 1, col: 1 });
  return score;
}

/** Run a program and return its Score, whether or not it declared a song. */
export function interpret(source, { steps, depth, log = () => {} } = {}) {
  const ast = parse(source);
  const score = new Score({ log });
  const state = {
    random: () => score.random(),
    reseed: (n) => score.reseed(n),
    log,
  };
  const builtins = new Map([...stdlib(state), ...musicBuiltins(score)]);
  const interp = new Interp({ builtins, hooks: musicHooks(score), steps, depth });
  interp.run(ast);
  return score;
}

/** [[bank, program], …] in slot order — what sf2bank.py builds. */
export function bankSelection(score) {
  return score.instruments.map((i) => [i.bank, i.program]);
}

const enc = new TextEncoder();
const utf8 = (t) => enc.encode(t);
const sectionOf = (doc, f) => doc.projSections.find((s) => s.fourcc === f)?.payload;

/** sMet for song 0: notation, beat bands, title, composer, copyright. */
function songMeta(score) {
  const s = score.song;
  const n = score.tuning.notation;
  const sub = [n & 0xff, n >> 8, s.beatRows, s.barRows, ...utf8(s.title), 0, ...utf8(s.composer), 0, ...utf8(s.copyright), 0];
  return Uint8Array.from([0, sub.length & 0xff, (sub.length >> 8) & 0xff, 0, 0, ...sub]);
}

/**
 * Build a whole project from TML source.
 *
 * @param host.sf2Bank   async (selection, {bpm, soundfont}) → .tsii bytes. The
 *                       soundfont is the song's `soundfont` (null = the bundled
 *                       GeneralUser GS).
 * @param host.log       build log lines (print() and the stages)
 * @param host.progress  (stage, fraction) while it runs
 * @param host.pause     awaited now and then, so a page can draw
 * @param host.embedSource  keep the source in the project (default true)
 * @returns {doc, score, report}
 */
export async function buildProject(source, host) {
  const { sf2Bank, log = () => {}, progress = () => {}, pause = null, embedSource = true, steps, depth } = host;
  progress("evaluate", 0);
  const score = evaluate(source, { steps, depth, log });
  const { song } = score;
  progress("compile", 0);
  const { patterns, cues, names } = compileScore(score);

  progress("bank", 0);
  const tsii = await sf2Bank(bankSelection(score), { bpm: song.tempo, soundfont: song.soundfont });
  const bank = parseTaud(tsii);
  if (bank.kind !== "tsii" && bank.kind !== "taud") throw new MotifError("the soundfont bank came back empty");

  // ── assemble ──
  const inamPayload = sectionOf(bank, "INam");
  const inam = inamPayload ? new TextDecoder().decode(inamPayload).split("\x1e") : [];
  for (const inst of score.instruments) {
    if (inst.name === null) continue;
    while (inam.length <= inst.slot) inam.push("");
    inam[inst.slot] = inst.name;
  }
  const master = score.master ? { ...defaultMastering(), ...score.master } : null;
  const projSections = [];
  const add = (fourcc, payload) => { if (payload && payload.length) projSections.push({ fourcc, payload }); };
  const is64 = score.lanes.length > 32;
  if (is64) {
    const xhdr = new Uint8Array(256);
    xhdr[0] = 0x01;
    add("xHDR", xhdr);
  }
  add("PNam", utf8(song.title));
  add("PCom", utf8(song.composer));
  add("PCpr", utf8(song.copyright));
  add("PMsg", utf8(song.message));
  add("INam", encodeNameTable(inam));
  add("SNam", sectionOf(bank, "SNam"));
  add("pNam", encodeNameTable(names));
  add("sMet", songMeta(score));
  if (score.tuning.nota) add("nota", score.tuning.nota);
  add("Ixmp", sectionOf(bank, "Ixmp"));
  if (master) add("sMst", buildMasteringSection({ 0: master }));

  const doc = new Document({
    kind: "taud",
    fmtVer: song.format,
    is64Channel: is64,
    signature: song.signature,
    sampleInstImage: bank.sampleInstImage,
    songs: [{
      numVoices: score.lanes.length, bpm: song.tempo, tickRate: song.speed,
      tuningBaseNote: 0x5c00, tuningFreq: song.a4, // "A4 sounds at a4 Hz"
      globalFlags: 0, globalVolume: song.globalVolume, mixingVolume: song.mixingVolume,
      surroundModel: song.surround,
      patterns, cues,
    }],
    projSections,
    ixmp: bank.ixmp,
    meta: { projectName: song.title, songMeta: {}, ...(master ? { mastering: { 0: master } } : {}) },
  });

  // ── per-instrument overrides, before cleanup (they decide what is reachable) ──
  progress("instruments", 0);
  const recOf = (slot) => doc.sampleInstImage.subarray(SAMPLEBIN_SIZE + slot * 256, SAMPLEBIN_SIZE + (slot + 1) * 256);
  const layersOf = (slot) => {
    const inst = doc.instruments[slot];
    return inst.isMeta ? inst.metaLayers.filter((l) => l.instIdx >= 1).map((l) => l.instIdx & 0x3ff) : [slot];
  };
  const keepsLayers = score.instruments.some((i) => i.layers);
  if (keepsLayers || score.instruments.some((i) => i.nna !== null || i.fadeout !== null)) {
    doc._rebuildInstRegion();
    for (const i of score.instruments) {
      if (!i.layers) continue;
      const inst = doc.instruments[i.slot];
      if (!inst.isMeta) throw new MotifError(`instrument ${i.id} has one layer, so it cannot keep layers ${i.layers.join(", ")}`);
      const keep = i.layers.map((k) => {
        const l = inst.metaLayers[k];
        if (!l) throw new MotifError(`instrument ${i.id} has layers 0–${inst.metaLayers.length - 1}; there is no layer ${k}`);
        return l;
      });
      doc.sampleInstImage.set(buildMetaRecord(keep, { strict: inst.metaStrict, percussion: inst.isPercussion, type: inst.metaType }), SAMPLEBIN_SIZE + i.slot * 256);
    }
    doc._resetInstrumentCache();
    for (const i of score.instruments) {
      if (i.nna === null && i.fadeout === null) continue;
      for (const L of layersOf(i.slot)) {
        const rec = recOf(L);
        if (i.nna !== null) rec[186] = (rec[186] & ~0x23) | (i.nna & 3) | (((i.nna >> 2) & 1) << 5);
        if (i.fadeout !== null) {
          rec[172] = i.fadeout & 0xff;
          rec[173] = (rec[173] & 0xf0) | ((i.fadeout >> 8) & 0x0f);
          for (const e of doc.ixmp) {
            if ((e.instId & 0x3ff) !== L) continue;
            const zones = parsePatchesBlob(e.blob);
            for (const z of zones) if (z.hasExtra) z.fadeoutStep = i.fadeout;
            e.blob = writePatchesBlob(zones);
          }
        }
      }
    }
    doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
    doc._resetInstrumentCache();
  }

  // ── cleanup ──
  progress("cleanup", 0);
  const samplesBefore = doc.sampleList().length;
  const plan = planIxmpCleanup(doc);
  if (!plan.noop) cleanupBankOp(plan).apply(doc);
  let removedInstruments = 0;
  if (keepsLayers) {
    const bankPlan = planBankCleanup(doc);
    if (!bankPlan.noop && bankPlan.removedInstruments) {
      cleanupBankOp(bankPlan).apply(doc);
      removedInstruments = bankPlan.removedInstruments;
    }
  }

  // ── minimum fadeouts: a zone may fade no slower than this ──
  const fades = score.instruments.filter((i) => i.minFadeout !== null);
  if (fades.length) {
    for (const i of fades) {
      const layers = new Set(doc.instruments[i.slot].isMeta
        ? doc.instruments[i.slot].metaLayers.map((l) => l.instIdx & 0x3ff)
        : [i.slot]);
      for (const e of doc.ixmp) {
        if (!layers.has(e.instId & 0x3ff)) continue;
        const zones = parsePatchesBlob(e.blob);
        for (const z of zones) if (z.hasExtra && z.fadeoutStep < i.minFadeout) z.fadeoutStep = i.minFadeout;
        e.blob = writePatchesBlob(zones);
      }
      i._fadeLayers = layers;
    }
    doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
    // …and each layer's own record, for zones that carry no fade of their own
    // (bytes 172–173: the low byte, then the high bits in the low nibble).
    for (const i of fades) {
      for (const slot of i._fadeLayers) {
        const rec = recOf(slot);
        if ((rec[172] | ((rec[173] & 0x0f) << 8)) < i.minFadeout) {
          rec[172] = i.minFadeout & 0xff;
          rec[173] = (rec[173] & 0xf0) | ((i.minFadeout >> 8) & 0x0f);
        }
      }
    }
    doc._resetInstrumentCache();
  }

  // ── layer gains, into each metainstrument's layer table (§7.5's octets) ──
  const gains = score.instruments.filter((i) => i.layerGain !== null);
  if (gains.length) {
    for (const i of gains) {
      const inst = doc.instruments[i.slot];
      if (!inst.isMeta) throw new MotifError(`instrument ${i.id} has a single layer; layer_gain is for a layered (meta) instrument`);
      const rec = recOf(i.slot);
      const octet = dbOctet(i.layerGain);
      for (const l of inst.metaLayers) rec[l.rawOffset + 1] = octet;
    }
    doc._resetInstrumentCache();
  }

  // ── re-tuning ──
  let retuned = [];
  if (song.retune) {
    progress("retune", 0);
    retuned = await retune(doc, retuneUses(score), {
      passes: 3, pause,
      progress: (done, total) => progress("retune", total ? done / total : 1),
    });
  }

  if (embedSource) doc.setSection(MOTIF_FOURCC, utf8(source));
  progress("done", 1);
  const worst = retuned.reduce((m, r) => Math.max(m, Math.abs(r.cents)), 0);
  const report = {
    lanes: score.lanes.length, patterns: patterns.length, cues: cues.length,
    samplesBefore, samplesAfter: doc.sampleList().length,
    zonesPruned: plan.removedPatches ?? 0, instrumentsRemoved: removedInstruments,
    retunedGroups: retuned.length, worstCents: worst,
  };
  log(`${report.lanes} lanes, ${report.patterns} patterns, ${report.cues} cues; samples ${report.samplesBefore} → ${report.samplesAfter} ` +
    `(${report.zonesPruned} zones pruned)` + (song.retune ? `; ${report.retunedGroups} zone groups re-tuned, worst ${worst.toFixed(1)} cents from the grid` : ""));
  return { doc, score, report };
}

/**
 * Every (note word, volume) each re-tuned instrument is triggered with, by
 * slot, in the order the song first writes them — the order retune() groups
 * and averages in, which a repeatable build depends on.
 */
function retuneUses(score) {
  const uses = new Map();
  const wide = score.wide;
  for (const lane of score.lanes) {
    for (const c of lane.ev.values()) {
      if (c.note === undefined || c.note < 0x20 || c.inst === undefined) continue; // glides trigger nothing
      const inst = score.instruments[c.inst - 1];
      if (!inst?.retune) continue;
      let vol = 63;
      if (c.vol !== undefined) {
        const v = c.vol * lane.trim;
        vol = Math.max(0, Math.min(63, Math.round(wide ? (v * 63) / 255 : v)));
      }
      if (!uses.has(c.inst)) uses.set(c.inst, []);
      uses.get(c.inst).push({ word: c.note, vol });
    }
  }
  return uses;
}
