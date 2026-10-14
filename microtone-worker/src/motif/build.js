// Motif's build: a TML source → a whole Taud project (Document). The same
// pipeline in the app and on the command line, byte for byte; only how the
// soundfont bank is made differs, so the host hands that step in.
//
//   evaluate     run the program (sandboxed) → the score
//   bank         the instruments, which is where each gets its slot: the
//                soundfont presets → a .tsii made by the app's own SF2 driver
//                (sf2bank.py) at the song's tempo; then instruments imported
//                from packs, generated waveforms, and the metainstruments
//                (layers, FM racks) built over them
//   compile      the score → patterns, cues, pattern names (compile.js)
//   assemble     bank + song + texts + notation + master → a Document
//   instruments  layer choice, New Note Action and fadeout overrides
//   cleanup      every Ixmp zone no note can reach is pruned, as the app's
//                Housekeeping does (and every instrument nothing plays, when
//                `keep_layers` left some behind)
//   tweak        minimum fadeouts, layer gains
//   retune       every zone the song plays, measured and moved onto the grid
//   source       the TML itself, saved in the project (PMtf) so it can be
//                opened, changed and rebuilt

import { parseTaud } from "../../core/format/taud-parse.js";
import { buildMasteringSection } from "../../core/format/mastering-section.js";
import { defaultMastering } from "../../core/engine/mastering.js";
import {
  parsePatchesBlob, writePatchesBlob, buildMetaRecord, makeMetaLayer, META_TYPE_FM, META_MAX_LAYERS,
} from "../../core/engine/inst.js";
import { LINEAR_FREQ_C4_HZ } from "../../core/engine/constants.js";
import { SAMPLEBIN_SIZE, SAMPLEINST_SIZE, CAPTURE_SIGNATURE } from "../../core/format/taud-const.js";
import { Document } from "../doc/document.js";
import { planIxmpCleanup, planBankCleanup, encodeNameTable } from "../doc/cleanup.js";
import { cleanupBankOp, importBankOp } from "../doc/ops.js";
import { buildIxmpSection, planImport, planSampleImport, splitNameTable, joinNameTable } from "../doc/bankmerge.js";
import { noise2 } from "./stdlib.js";
import { emptyPattern } from "./compile.js";
import { MotifError } from "./lexer.js";
import { parse } from "./parser.js";
import { Interp } from "./interp.js";
import { stdlib, stdlib2 } from "./stdlib.js";
import { Score, musicBuiltins, musicHooks, dbOctet } from "./music.js";
import { resolve } from "./phrase.js";
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
  if (!score.song) throw new MotifError("the file declares no song: write song { … } after the tml line", { line: 1, col: 1 });
  if (!score.instruments.length) throw new MotifError("the song has no instruments: declare one with instrument NAME { bank: …, program: … }", { line: 1, col: 1 });
  if (!score.lanes.length) throw new MotifError("the song has no lanes: declare one with lane NAME { inst: … }", { line: 1, col: 1 });
  return score;
}

/** Run a program and return its Score, whether or not it declared a song.
 *  `capture`: the source offset of a call; the score's `capture` then holds
 *  what that call wrote, each time it ran (the Motif view's preview). */
export function interpret(source, { steps, depth, log = () => {}, capture = null } = {}) {
  const ast = parse(source);
  if (ast.version >= 2) return interpret2(ast, { steps, depth, log, capture });
  const score = new Score({ log });
  const state = {
    random: () => score.random(),
    reseed: (n) => score.reseed(n),
    log,
  };
  const builtins = new Map([...stdlib(state), ...musicBuiltins(score)]);
  const interp = new Interp({ builtins, hooks: musicHooks(score), steps, depth });
  if (capture !== null) {
    score.capture = { lanes: new Map(), test: () => interp.stack.some((f) => f.pos?.offset === capture) };
  }
  interp.run(ast);
  return score;
}

/**
 * A TML 2 program: run it, which makes its music as a value; place that
 * music (resolve: the cells placed for certain, then the fitted parts against
 * them); and fill the score from it in time order.
 */
function interpret2(ast, { steps, depth, log, capture }) {
  const score = new Score({ log, version: 2 });
  const base = stdlib2({ seed: () => score.seed, log });
  const builtins = new Map([...base, ...musicBuiltins(score, { version: 2, base })]);
  const interp = new Interp({ builtins, hooks: musicHooks(score), steps, depth });
  if (capture !== null) {
    interp.captureAt = capture;
    score.capture = { lanes: new Map(), test: () => interp.capturing > 0 };
  }
  interp.run(ast);
  if (score.song) {
    let cells;
    try {
      cells = resolve(score, interp.result, interp);
    } catch (err) {
      throw interp.wrap(err, ast.pos);
    }
    score.fill(cells);
  }
  return score;
}

/**
 * What one call writes — the preview of `melody(…)`, `hit(…)` or a function of
 * your own: the program runs as for a build, and every cell the call at
 * `offset` writes (each time it runs) is kept. Plain data, ready to post:
 * {song, lanes: [{index, id, label, trim, jitter, cells: [[row, fields]]}],
 *  instruments: [{id, kind, slot}], first, last}. Cells name their
 * instrument by id (`instId`); slots are the provisional ones (§7.3).
 */
export function captureCall(source, offset, opts = {}) {
  const score = interpret(source, { ...opts, capture: offset });
  if (!score.song) throw new MotifError("the program declares no song yet");
  let first = Infinity, last = -Infinity;
  const lanes = [];
  for (const [lane, rows] of score.capture.lanes) {
    const cells = [...rows].sort((p, q) => p[0] - q[0]).map(([row, c]) => {
      const out = { ...c };
      if (out.inst) { out.instId = out.inst.id; delete out.inst; }
      return [row, out];
    });
    if (!cells.length) continue;
    first = Math.min(first, cells[0][0]);
    last = Math.max(last, cells[cells.length - 1][0]);
    lanes.push({ index: lane.index, id: lane.id, label: lane.label, trim: lane.trim, jitter: lane.jitter, instId: lane.instrument.id, cells });
  }
  lanes.sort((p, q) => p.index - q.index);
  const s = score.song;
  return {
    song: {
      tempo: s.tempo, speed: s.speed, barRows: s.barRows, cueBars: s.cueBars, bars: s.bars,
      format: s.format, rows: score.rows, notation: score.tuning.notation,
    },
    names: Object.fromEntries(lanes.flatMap((l) => l.cells).filter(([, c]) => c.note >= 0x20)
      .map(([, c]) => [c.note, score.tuning.nameOfWord(c.note) ?? `$${c.note.toString(16).toUpperCase()}`])),
    lanes,
    instruments: score.instruments.map((i) => ({ id: i.id, kind: i.kind, slot: i.slot })),
    first: lanes.length ? first : null, last: lanes.length ? last : null,
  };
}

/** [[bank, program], …] of the soundfont presets, in the order they are
 *  declared — what sf2bank.py builds, and the slots they take (1, 2, …). */
export function bankSelection(score) {
  return score.instruments.filter((i) => i.kind === "sf2").map((i) => [i.bank, i.program]);
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
 * @param host.pack      async (name) → the bytes of the instrument pack (.tsii
 *                       or .taud) an instrument's `pack` names
 * @param host.log       build log lines (print() and the stages)
 * @param host.progress  (stage, fraction) while it runs
 * @param host.pause     awaited now and then, so a page can draw
 * @param host.embedSource  keep the source in the project (default true)
 * @param host.signature    the file's 14-character signature (default
 *                          "Microtone.js"). Not the program's to choose: it
 *                          says what wrote the file, so the host decides — the
 *                          demo songs' Makefile passes "Microtone Demo", and
 *                          the app keeps the signature of a project it rebuilds.
 * @returns {doc, score, report}
 */
export async function buildProject(source, host) {
  const { sf2Bank, log = () => {}, progress = () => {}, pause = null, embedSource = true, steps, depth } = host;
  const signature = checkSignature(host.signature ?? CAPTURE_SIGNATURE);
  progress("evaluate", 0);
  const score = evaluate(source, { steps, depth, log });
  const { song } = score;

  progress("bank", 0);
  const bank = await assembleBank(score, { sf2Bank, pack: host.pack, log });

  progress("compile", 0);
  const { patterns, cues, names } = compileScore(score);

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
    signature,
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
  const keepsLayers = score.instruments.some((i) => i.keepLayers);
  if (keepsLayers || score.instruments.some((i) => i.nna !== null || i.fadeout !== null)) {
    doc._rebuildInstRegion();
    for (const i of score.instruments) {
      if (!i.keepLayers) continue;
      const inst = doc.instruments[i.slot];
      if (!inst.isMeta) throw new MotifError(`instrument ${i.id} has one layer, so it cannot keep layers ${i.keepLayers.join(", ")}`);
      const keep = i.keepLayers.map((k) => {
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
    // which slot each instrument took — what a preview plays through
    slots: Object.fromEntries(score.instruments.map((i) => [i.id, i.slot])),
  };
  log(`${report.lanes} lanes, ${report.patterns} patterns, ${report.cues} cues; samples ${report.samplesBefore} → ${report.samplesAfter} ` +
    `(${report.zonesPruned} zones pruned)` + (song.retune ? `; ${report.retunedGroups} zone groups re-tuned, worst ${worst.toFixed(1)} cents from the grid` : ""));
  return { doc, score, report };
}

// ── the bank ──

/**
 * Every instrument the song declares, in one bank, each given its slot. A song
 * of soundfont presets alone is exactly the bank sf2bank.py builds (slots in
 * the order they are declared); anything else is added to it the way the
 * Instruments view adds it — a pack's instruments by the app's bank import, a
 * waveform as a new sample, a metainstrument as a new record over the slots of
 * the instruments it is made of. Returns the parsed-bank shape the rest of the
 * build reads ({sampleInstImage, ixmp, projSections}).
 */
async function assembleBank(score, { sf2Bank, pack, log }) {
  const { song } = score;
  const sf2s = score.instruments.filter((i) => i.kind === "sf2");
  let bank = null;
  if (sf2s.length) {
    if (!sf2Bank) throw new MotifError("this build cannot make soundfont instruments");
    bank = parseTaud(await sf2Bank(bankSelection(score), { bpm: song.tempo, soundfont: song.soundfont }));
    if (!bank.sampleInstImage) throw new MotifError("the soundfont bank came back empty");
    sf2s.forEach((inst, k) => { inst.slot = k + 1; });
  }
  const others = score.instruments.filter((i) => i.kind !== "sf2");
  if (!others.length) return bank;

  // a scratch project to import into: the soundfont bank so far, or nothing
  const work = new Document({
    kind: "taud", fmtVer: 2, is64Channel: false, signature: CAPTURE_SIGNATURE,
    sampleInstImage: bank ? bank.sampleInstImage : new Uint8Array(SAMPLEINST_SIZE),
    songs: [{
      numVoices: 1, bpm: 125, tickRate: 6, tuningBaseNote: 0, tuningFreq: 0, globalFlags: 0,
      globalVolume: 128, mixingVolume: 128, surroundModel: 0,
      patterns: [emptyPattern(false)], cues: [new Uint16Array(64).fill(0x7fff)],
    }],
    projSections: bank ? bank.projSections.filter((x) => ["INam", "SNam", "Ixmp"].includes(x.fourcc)) : [],
    ixmp: bank ? bank.ixmp : [],
    meta: { projectName: "", songMeta: {} },
  });

  // instruments from packs, a pack at a time
  const packs = new Map();
  for (const i of others) if (i.kind === "pack") (packs.get(i.pack) ?? packs.set(i.pack, []).get(i.pack)).push(i);
  for (const [file, insts] of packs) {
    if (!pack) throw new MotifError(`instrument ${insts[0].id} comes from the pack "${file}", which this build cannot open`);
    const parsed = parseTaud(await pack(file));
    if (!parsed.sampleInstImage) throw new MotifError(`"${file}" holds no instruments`);
    const src = new Document(parsed);
    const used = new Set(src.usedInstrumentSlots());
    for (const i of insts) {
      if (typeof i.packSlot === "number") {
        if (!used.has(i.packSlot)) throw new MotifError(`instrument ${i.id}: "${file}" has nothing in slot ${i.packSlot}`);
        i.srcSlot = i.packSlot;
      } else {
        const hit = [...used].sort((a, b) => a - b).find((sl) => src.instrumentName(sl) === i.packSlot);
        if (hit === undefined) throw new MotifError(`instrument ${i.id}: "${file}" has no instrument named "${i.packSlot}"`);
        i.srcSlot = hit;
      }
    }
    const plan = planImport(work, src, insts.map((i) => i.srcSlot));
    if (plan.error) throw new MotifError(`importing from "${file}": ${plan.error}`);
    importBankOp(plan).apply(work);
    for (const i of insts) i.slot = plan.slotMap.get(i.srcSlot);
    log(`${insts.length} instrument${insts.length === 1 ? "" : "s"} from ${file}`);
  }

  // generated waveforms: a single cycle each, looped, tuned so C4 sounds at C4
  for (const i of others) {
    if (i.kind !== "wave") continue;
    const pcm = waveform(i.wave, i.length);
    const { rate, detune } = tuneForMiddleC(pcm.length);
    const plan = planSampleImport(work, { nameBytes: utf8(i.name ?? i.id), pcm, rate, detune, loop: true });
    if (plan.error) throw new MotifError(`instrument ${i.id}: ${plan.error}`);
    importBankOp(plan).apply(work);
    i.slot = plan.insts[0].destSlot;
    if (i.envelope) {
      work._rebuildInstRegion();
      const inst = work.instruments[i.slot];
      for (let k = 0; k < 25; k++) inst.volEnvelopes[k] = i.envelope.nodes[Math.min(k, i.envelope.nodes.length - 1)];
      inst.volEnvLoop = 0x2000; // P: present
      inst.volEnvSustainWord = i.envelope.susWord;
      writeRecord(work, i.slot, inst);
    }
  }

  // metainstruments, in the order they are declared (one may be made of another)
  for (const i of others) {
    if (i.kind !== "layers" && i.kind !== "fm") continue;
    work._rebuildInstRegion();
    const record = i.kind === "layers" ? layeredRecord(work, i) : rackRecord(work, i);
    const taken = new Set(work.usedInstrumentSlots());
    let slot = 1;
    while (slot <= 255 && taken.has(slot)) slot++;
    if (slot > 255) throw new MotifError(`instrument ${i.id}: no free instrument slots left in $01–$FF`);
    work.sampleInstImage.set(record, SAMPLEBIN_SIZE + slot * 256);
    work._resetInstrumentCache();
    i.slot = slot;
    const parts = splitNameTable(sectionOf(work, "INam") ?? null);
    while (parts.length <= slot) parts.push(new Uint8Array(0));
    parts[slot] = utf8(i.name ?? i.id);
    work.setSection("INam", joinNameTable(parts));
  }
  work._rebuildInstRegion();
  return {
    sampleInstImage: work.sampleInstImage,
    ixmp: work.ixmp,
    projSections: work.projSections.filter((x) => ["INam", "SNam", "Ixmp"].includes(x.fourcc)),
  };
}

/** Write a decoded instrument back into the image. */
function writeRecord(doc, slot, inst) {
  const rec = new Uint8Array(256);
  for (let k = 0; k < 256; k++) rec[k] = inst.getByteNormal(k);
  doc.sampleInstImage.set(rec, SAMPLEBIN_SIZE + slot * 256);
  doc._resetInstrumentCache();
}

/** One cycle of a waveform as unsigned 8-bit PCM — the Sample Lab's paint
 *  presets, so a `wave` sounds like the instrument painted from the same one. */
export function waveform(shape, length) {
  const pcm = new Uint8Array(length);
  for (let k = 0; k < length; k++) {
    const p = k / length;
    let v = 128;
    switch (shape) {
      case "sine": case "opl0": v = 128 + 127 * Math.sin(2 * Math.PI * p); break;
      case "saw": v = 255 * p; break;
      case "square": case "opl6": v = p < 0.5 ? 255 : 0; break;
      case "triangle": v = p < 0.5 ? 510 * p : 510 * (1 - p); break;
      case "noise": v = 128 + 127 * noise2(k, length); break; // a fixed noise: the same every build
      case "opl1": v = 128 + 127 * Math.max(0, Math.sin(2 * Math.PI * p)); break;
      case "opl2": v = 128 + 127 * Math.abs(Math.sin(2 * Math.PI * p)); break;
      case "opl3": { const q = p % 0.5; v = q < 0.25 ? 128 + 127 * Math.sin(2 * Math.PI * q) : 128; break; }
      case "opl4": v = p < 0.5 ? 128 + 127 * Math.sin(4 * Math.PI * p) : 128; break;
      case "opl5": v = p < 0.5 ? 128 + 127 * Math.abs(Math.sin(4 * Math.PI * p)) : 128; break;
      case "opl7": v = p < 0.5 ? 128 + 127 * Math.pow(2, -32 * p) : 128 - 127 * Math.pow(2, -32 * (1 - p)); break;
      default: throw new MotifError(`"${shape}" is not a waveform`);
    }
    pcm[k] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return pcm;
}

/** The rate and detune that make a looped cycle of `n` frames sound middle C
 *  at C4: the rate as high as its 16 bits allow, the detune taking up the rest
 *  (the waveform painter's own tuning). */
function tuneForMiddleC(n) {
  const target = LINEAR_FREQ_C4_HZ * n;
  let rate = target;
  while (rate > 0xffff) rate /= 2;
  while (rate < 1) rate *= 2;
  const r = Math.max(1, Math.min(0xffff, Math.round(rate)));
  return { rate: r, detune: Math.max(-32768, Math.min(32767, Math.round(4096 * Math.log2(target / r)))) };
}

const octetToDb = (o) => {
  if (o === 0) return -Infinity;
  if (o >= 232) return 12.5 + (o - 232) * 0.5;
  if (o >= 208) return 6.25 + (o - 208) * 0.25;
  if (o >= 112) return -5.875 + (o - 112) * 0.125;
  if (o >= 88) return -11.75 + (o - 88) * 0.25;
  if (o >= 64) return -23.5 + (o - 64) * 0.5;
  if (o >= 2) return -85 + (o - 2);
  return -86;
};

/** A layered metainstrument's record. A layer over an ordinary instrument
 *  points at it; a layer over a layered one stands in for all of ITS layers
 *  (a layer cannot hold a metainstrument), each with the two gains added, the
 *  two detunes added and the two rectangles intersected. */
function layeredRecord(work, i) {
  const out = [];
  let strict = i.strict;
  for (const L of i.layers) {
    const ref = work.instruments[L.ref.slot];
    if (!ref.isMeta) {
      out.push(L.fixed !== null
        ? makeMetaLayer(L.ref.slot, dbOctet(L.gain), L.fixed, L.pitchStart, L.pitchEnd, L.volStart, L.volEnd, true)
        : makeMetaLayer(L.ref.slot, dbOctet(L.gain), L.detune, L.pitchStart, L.pitchEnd, L.volStart, L.volEnd));
      continue;
    }
    if (ref.isFm) throw new MotifError(`instrument ${i.id}: ${L.ref.id} is an FM rack, which cannot be a layer`);
    strict = strict || ref.metaStrict;
    for (const c of ref.metaLayers) {
      if ((c.instIdx & 0x3ff) === 0) continue;
      const ps = Math.max(c.pitchStart, L.pitchStart), pe = Math.min(c.pitchEnd, L.pitchEnd);
      const vs = Math.max(c.volStart, L.volStart), ve = Math.min(c.volEnd, L.volEnd);
      if (ps > pe || vs > ve) continue;
      const gain = octetToDb(c.mixOctet) + L.gain;
      const octet = gain === -Infinity ? 0 : dbOctet(Math.max(-86, Math.min(24, gain)));
      let fixed = c.fixedPitch, det = c.detune;
      if (L.fixed !== null) { fixed = true; det = L.fixed; }
      else if (fixed) det = Math.max(0x20, Math.min(0xffff, (c.detune & 0xffff) + L.detune));
      else det = Math.max(-0x8000, Math.min(0x7fff, c.detune + L.detune));
      out.push(makeMetaLayer(c.instIdx & 0x3ff, octet, det, ps, pe, vs, ve, fixed));
    }
  }
  if (!out.length) throw new MotifError(`instrument ${i.id}: none of its layers can sound (their ranges miss each other)`);
  if (out.length > META_MAX_LAYERS) throw new MotifError(`instrument ${i.id} would hold ${out.length} layers; a metainstrument holds at most ${META_MAX_LAYERS}`);
  return buildMetaRecord(out, { strict, percussion: i.percussion });
}

/** An FM rack's record: each operator reads an ordinary instrument. */
function rackRecord(work, i) {
  const ops = i.operators.map((op, k) => {
    const ref = work.instruments[op.ref.slot];
    if (ref.isMeta) {
      throw new MotifError(`instrument ${i.id}: operator ${k} reads ${op.ref.id}, a metainstrument; an operator reads one sample (a wave, usually)`);
    }
    return makeMetaLayer(op.ref.slot, dbOctet(op.level), op.detune, op.pitchStart, op.pitchEnd, op.volStart, op.volEnd);
  });
  return buildMetaRecord(ops, { type: META_TYPE_FM, percussion: i.percussion, program: i.program === null ? null : Uint16Array.from(i.program) });
}

/** A file signature: up to 14 printable ASCII characters, padded with spaces. */
export function checkSignature(sig) {
  if (typeof sig !== "string" || sig.length > 14 || /[^\x20-\x7e]/.test(sig)) {
    throw new MotifError(`a file signature is up to 14 plain ASCII characters, not ${JSON.stringify(sig)}`);
  }
  return sig.padEnd(14, " ");
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
      if (!c.inst.retune) continue;
      let vol = 63;
      if (c.vol !== undefined) {
        const v = c.vol * lane.trim;
        vol = Math.max(0, Math.min(63, Math.round(wide ? (v * 63) / 255 : v)));
      }
      if (!uses.has(c.inst.slot)) uses.set(c.inst.slot, []);
      uses.get(c.inst.slot).push({ word: c.note, vol });
    }
  }
  return uses;
}
