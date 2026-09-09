// Conversion pipeline — the vendored *2taud.py converters running under the
// vendored Pyodide runtime, driven through the SAME convert-core the Web
// Worker uses. Slow (~1 s runtime boot + real conversions) but it proves the
// whole import path headlessly: tracker file in → parseable .taud out that
// the Document layer accepts.
//
// The MIDI test needs a soundfont: it uses GeneralUser-GS.sf2 from the repo
// root (32 MB, not committed) and auto-skips when absent — same pattern as
// the conformance suite's reference dumps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "../../vendor/pyodide/pyodide.js";
import {
  CONVERTER_SOURCES, SF2BANK_SOURCE, BNKBANK_SOURCE, converterFor,
  loadConverterRuntime, runConverter, buildArgv,
} from "../../src/convert/convert-core.js";
import { parseTaud } from "../../src/format/taud-parse.js";
import { CUE_EMPTY, NUM_PATTERNS_MAX } from "../../src/format/taud-const.js";
import { tuningRatioOf } from "../../src/engine/tables.js";
import { presetForNotation, surveyTuning } from "../../src/ui/pitchtables.js";
import { Document, combineTpif, sampleSpans, isStereoSample } from "../../src/doc/document.js";
import { planImport } from "../../src/doc/bankmerge.js";
import { importBankOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";
import { loadIntoEngine } from "../../src/audio/offline-render.js";
import { TRACKER_CHUNK } from "../../src/engine/constants.js";
import { TaudEngine } from "../../src/engine/engine.js";
import { patchIsStereo } from "../../src/engine/inst.js";
import { unescapeName } from "../../src/ui/names.js";
import { IMS_BANK, IMS_SONG, IMS_SONG_12RPB, IMS_EVENTS, JOHAB_TITLE, makeIms } from "../fixtures/ims.js";
import { cueInstructionWords } from "../../src/format/taud-parse.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const importDir = root + "test/corpus/import/";
const sf2Path = root + "GeneralUser-GS.sf2";

const sources = {};
for (const name of CONVERTER_SOURCES) {
  sources[name] = await readFile(root + "vendor/converters/" + name);
}
sources[SF2BANK_SOURCE] = await readFile(root + "src/convert/" + SF2BANK_SOURCE);
sources[BNKBANK_SOURCE] = await readFile(root + "src/convert/" + BNKBANK_SOURCE);
const py = await loadConverterRuntime({
  loadPyodide,
  indexURL: root + "vendor/pyodide/",
  sources,
});

function convert(fileName, opts = {}) {
  const conv = converterFor(fileName);
  const inPath = "/in." + fileName.toLowerCase().split(".").pop();
  const inputs = [{ path: inPath,
                    bytes: opts.bytes ?? readFileSync(importDir + fileName) }];
  if (conv.isMidi) inputs.push({ path: "/sf.sf2", bytes: readFileSync(sf2Path) });
  const bankPaths = (opts.banks ?? []).map((b, i) => `/bank${i}.bnk`);
  bankPaths.forEach((path, i) => inputs.push({ path, bytes: opts.banks[i] }));
  return runConverter(py, {
    script: conv.script,
    argv: buildArgv({
      isMidi: conv.isMidi, needsBank: conv.needsBank, inPath, sf2Path: "/sf.sf2",
      bankPaths, outPath: "/out.taud",
      rpb: opts.rpb ?? null, trimPatches: opts.trimPatches === true,
      keepDuplicatePatterns: opts.keepDuplicatePatterns === true,
      realign: opts.realign ?? null,
      quantise: opts.quantise ?? null,
      quantiseStrength: opts.quantiseStrength ?? 100,
    }),
    inputs,
    output: "/out.taud",
    onLog: () => {},
  });
}

test("converterFor maps extensions", () => {
  assert.equal(converterFor("song.XM").script, "xm2taud.py");
  assert.equal(converterFor("a.b.mod").script, "mod2taud.py");
  assert.ok(converterFor("x.MID").isMidi);
  assert.equal(converterFor("song.taud"), null);
  assert.equal(converterFor("noext"), null);
});

test("buildArgv pins MIDI rows-per-beat only when requested (item 62)", () => {
  const midi = (rpb) => buildArgv({ isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud", rpb });
  // auto (null / omitted / "auto") → no --rpb, converter picks the grid
  assert.deepEqual(midi(null), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(midi("auto"), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  // pinned value → --rpb N appended (string, matching the argparse choices)
  assert.deepEqual(midi(8), ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8"]);
  assert.deepEqual(midi("16"), ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "16"]);
  // rpb is MIDI-only — tracker argv never carries it
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.xm", outPath: "/out.taud", rpb: 8 }),
    ["/in.xm", "/out.taud", "-v"]);
});

test("buildArgv opts IN to stereo samples only when asked (item 90.1)", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, stereoSamples: false }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, stereoSamples: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--stereo-samples"]);
  // Stacks with the other MIDI options, in argparse-safe order.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true, stereoSamples: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches", "--stereo-samples"]);
  // Tracker argv never carries it — it is a SoundFont concern.
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.it", outPath: "/out.taud", stereoSamples: true }),
    ["/in.it", "/out.taud", "-v"]);
});

test("buildArgv opts IN to patch trimming only when asked (item 75)", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  // Default: NO flag — the converter keeps each preset's full zone map and the
  // editor's Housekeeping decides what to drop.
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, trimPatches: false }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, trimPatches: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--trim-unused-patches"]);
  // Composes with --rpb, and stays MIDI-only.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches"]);
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.xm", outPath: "/out.taud", trimPatches: true }),
    ["/in.xm", "/out.taud", "-v"]);
});

test("buildArgv opts IN to keeping duplicate patterns only when asked", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  // Default: NO flag — the converter pools byte-identical patterns.
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, keepDuplicatePatterns: false }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, keepDuplicatePatterns: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--no-dedup-patterns"]);
  // Stacks with the other MIDI options, in argparse-safe order.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true, stereoSamples: true,
                               keepDuplicatePatterns: true }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches",
     "--stereo-samples", "--no-dedup-patterns"]);
  // Pattern pooling is a MIDI-converter concern — tracker argv never carries it.
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud",
                               keepDuplicatePatterns: true }),
    ["/in.mod", "/out.taud", "-v"]);
});

test("buildArgv opts IN to quantisation only when asked (item 168)", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  // Default: NO flag — the performance's own timing is what gets converted.
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, quantise: null }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, quantise: "off" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, quantise: "auto" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "auto"]);
  assert.deepEqual(buildArgv({ ...base, quantise: "row" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "row"]);
  assert.deepEqual(buildArgv({ ...base, quantise: 16 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "16"]);
  // Full strength is the converter's own default, so it is never spelled out.
  assert.deepEqual(buildArgv({ ...base, quantise: 8, quantiseStrength: 100 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "8"]);
  assert.deepEqual(buildArgv({ ...base, quantise: 8, quantiseStrength: 50 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--quantise", "8", "--quantise-strength", "50"]);
  // A strength with no grid is not a request to quantise.
  assert.deepEqual(buildArgv({ ...base, quantiseStrength: 50 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  // Stacks with the other MIDI options, in argparse-safe order.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true, stereoSamples: true,
                               keepDuplicatePatterns: true, quantise: "auto" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches",
     "--stereo-samples", "--no-dedup-patterns", "--quantise", "auto"]);
  // Timing quantisation is a MIDI concern — tracker argv never carries it.
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud",
                               quantise: "auto" }),
    ["/in.mod", "/out.taud", "-v"]);
});

test("buildArgv opts IN to tempo realignment only when asked (item 183)", () => {
  const base = { isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" };
  // Default: NO flag — the file's own declared tempo is believed.
  assert.deepEqual(buildArgv(base), ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, realign: null }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, realign: "off" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v"]);
  assert.deepEqual(buildArgv({ ...base, realign: "auto" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--realign-tempo", "auto"]);
  // A punched-in tempo goes through as the number it is, fractions included.
  assert.deepEqual(buildArgv({ ...base, realign: 81 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--realign-tempo", "81"]);
  assert.deepEqual(buildArgv({ ...base, realign: 83.5 }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--realign-tempo", "83.5"]);
  // Realignment precedes quantisation on the command line as in the pipeline:
  // the grid has to be right before anything is snapped onto it.
  assert.deepEqual(buildArgv({ ...base, rpb: 8, trimPatches: true, stereoSamples: true,
                               keepDuplicatePatterns: true, realign: "auto", quantise: "row" }),
    ["/in.mid", "/sf.sf2", "/out.taud", "-v", "--rpb", "8", "--trim-unused-patches",
     "--stereo-samples", "--no-dedup-patterns", "--realign-tempo", "auto",
     "--quantise", "row"]);
  // A tempo map is a MIDI concern — tracker argv never carries it.
  assert.deepEqual(buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud",
                               realign: "auto" }),
    ["/in.mod", "/out.taud", "-v"]);
});

/** Drive midi2taud\'s tempo-realignment entry points on a synthetic event list.
 *  These need neither a soundfont nor a MIDI file: the functions under test take
 *  the (division, merged) pair parse_midi produces, and building one by hand is
 *  what makes the grid under test visible in the test itself. `body` runs with
 *  `M` bound to the module and must leave its result in `out`; stderr (where the
 *  converter puts the decision it made) comes back alongside it. */
function realignProbe(body) {
  const src = `
import contextlib, io, json, sys
sys.path.insert(0, "/converters")
import midi2taud as M

def events(tpq, bpm, onsets, tempo=True):
    """(division, merged) for note-ons at \`onsets\`, each a tenth of a beat long."""
    merged = []
    seq = 0
    if tempo:
        merged.append((0, seq, ('tempo', float(bpm)))); seq += 1
    for t in onsets:
        merged.append((t, seq, ('on', 0, 60, 100))); seq += 1
        merged.append((t + 10, seq, ('off', 0, 60))); seq += 1
    merged.sort(key=lambda e: (e[0], e[1]))
    return ('ppq', tpq), merged

_err = io.StringIO()
with contextlib.redirect_stderr(_err):
${body.split("\n").map((l) => "    " + l).join("\n")}
json.dumps({"out": out, "stderr": _err.getvalue()})
`;
  return JSON.parse(py.runPython(src));
}

/** A minimal 4-channel "M.K." module: one pattern, one note per row, each a
 *  period straight out of ProTracker's table. Synthesised rather than shipped
 *  as a corpus binary so the periods under test are visible right here. */
function makeMod(periods) {
  const N_SAMPLES = 31, CH = 4, SAMPLE_WORDS = 8;
  const head = 20 + N_SAMPLES * 30 + 1 + 1 + 128 + 4;
  const buf = new Uint8Array(head + 1024 + SAMPLE_WORDS * 2);
  const put = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  put(0, "pt-grid probe");
  const s1 = 20;                       // sample 1's 30-byte header
  put(s1, "probe");
  buf[s1 + 23] = SAMPLE_WORDS;         // length in words (big-endian)
  buf[s1 + 25] = 64;                   // volume; finetune 0, loop len 1 = none
  buf[s1 + 29] = 1;
  const o = 20 + N_SAMPLES * 30;
  buf[o] = 1;                          // one order, and it plays pattern 0
  buf[o + 1] = 127;                    // restart
  put(o + 2 + 128, "M.K.");
  periods.forEach((period, row) => {
    const c = head + row * CH * 4;      // channel 0 of this row
    buf[c] = (period >> 8) & 0x0f;      // sample hi nibble 0 | period hi
    buf[c + 1] = period & 0xff;
    buf[c + 2] = 1 << 4;                // sample 1 lo nibble, effect 0
  });
  return buf;
}

test("mod2taud stamps notation 1 and its notes land on the ProTracker grid", () => {
  // A spread across PT's range, including all four entries whose octave is not
  // a clean doubling (D-3 190, E-3 170, G-3 143, G#3 135) plus B-1 453 — the
  // notes no octave-repeating table could place.
  const periods = [428, 404, 381, 339, 170, 143, 135, 190, 453, 856, 214, 113];
  const out = runConverter(py, {
    script: "mod2taud.py",
    argv: buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud" }),
    inputs: [{ path: "/in.mod", bytes: makeMod(periods) }],
    output: "/out.taud",
    onLog: () => {},
  });
  const doc = new Document(parseTaud(out));
  assert.equal(doc.meta.songMeta[0].notation, 1, "sMet notation must be ProTracker pitch");
  const preset = presetForNotation(doc.meta.songMeta[0].notation, doc);
  assert.equal(preset.name, "ProTracker Temperament"); // renamed in e31d771

  const onPt = surveyTuning(doc.songs[0], preset, null);
  assert.equal(onPt.total, periods.length);
  assert.equal(onPt.offGrid, 0, "a converted .mod must be fully in tune");
  assert.equal(onPt.wouldChange, 0, "and exactly on the grid, not merely near it");

  // The same notes under the old 12-TET default: the bug this fixes.
  assert.ok(surveyTuning(doc.songs[0], presetForNotation(120), null).offGrid > 0);
});

test("xm2taud under Pyodide → parseable, loadable document", () => {
  const out = convert("milky.xm");
  const doc = new Document(parseTaud(out));
  assert.equal(doc.kind, "taud");
  assert.equal(doc.songs.length, 1);
  assert.ok(doc.songs[0].patterns.length > 0);
  assert.ok(doc.usedInstrumentSlots().length > 0);
  assert.ok(doc.sampleList().length > 0);
  // #66: SNam is pool-ordered and 0-based — census sample 0 carries its own
  // name (before the fix a reserved leading '' shifted every name by one and
  // left sample 0 unnamed).
  assert.deepEqual(doc.sampleList().map((s) => s.name),
    ["beng", "bass", "perc", "lead"]);
});

test("it2taud under Pyodide → parseable, loadable document", () => {
  const out = convert("TUTE.IT");
  const doc = new Document(parseTaud(out));
  assert.equal(doc.kind, "taud");
  assert.ok(doc.songs[0].patterns.length > 0);
  assert.ok(doc.usedInstrumentSlots().length > 0);
  // #66: 0-based SNam, no leading-empty shift.
  assert.deepEqual(doc.sampleList().map((s) => s.name),
    ["Aurora", "Synth Pad", "Panflute", "Low Strings", "Open Hihat", "Bass Drum"]);
  // Item 115.2: IT's song message rides across as PMsg, CR-separated lines
  // translated to LF and the editor's trailing padding trimmed.
  const msg = doc.projectString("PMsg");
  assert.ok(msg.startsWith("\n                               Twilight Tears\n\n"), msg.slice(0, 60));
  assert.ok(msg.includes("Composed as a very simple example of how to use virtual channels."));
  assert.ok(!msg.includes("\r"), "CR must not survive into PMsg");
  assert.ok(!/[ \t]\n/.test(msg), "trailing line padding must be trimmed");
  assert.ok(!msg.endsWith("\n"), "trailing blank lines must be trimmed");
});

test("it2taud carries NNA, and sample-mode files get Note Cut", () => {
  // Instrument mode: TUTE.IT's six instruments are IT NNA 2,2,2,1,3,0 —
  // note off, continue and fade all present. IT numbers them 0=cut,
  // 1=continue, 2=off, 3=fade; Taud numbers them 0=off, 1=cut, 2=continue,
  // 3=fade, so the mapping is a permutation, not a copy.
  const instMode = new Document(parseTaud(convert("TUTE.IT")));
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((s) => instMode.instruments[s].newNoteAction),
    [0, 0, 0, 2, 3, 1]);

  // Sample mode: the same file with the header's "use instruments" flag
  // cleared. IT has no NNA there at all — a new note replaces the channel's
  // voice — so every slot must read Note Cut (1). It used to read Note Off,
  // which spawns a ghost per trigger that a sample with no volume envelope
  // and no fadeout never stops. Its default pan and auto-vibrato come from
  // the sample header too, so plant both on sample 1 and follow them across.
  const it = Buffer.from(readFileSync(importDir + "TUTE.IT"));
  it.writeUInt16LE(it.readUInt16LE(0x2c) & ~0x04, 0x2c);      // flags: no instruments
  const smpPtr = it.readUInt32LE(0xc0 + it.readUInt16LE(0x20) // OrdNum
                                     + 4 * it.readUInt16LE(0x22));  // + InsNum ptrs
  it[smpPtr + 0x2f] = 0x80 | 48;   // default pan, "use" bit set
  it[smpPtr + 0x4c] = 16;          // auto-vibrato speed  (Vis)
  it[smpPtr + 0x4d] = 32;          // auto-vibrato depth  (Vid)
  it[smpPtr + 0x4e] = 200;         // auto-vibrato rate   (Vir)
  it[smpPtr + 0x4f] = 2;           // auto-vibrato square (Vit)

  const smpMode = new Document(parseTaud(convert("TUTE.IT", { bytes: it })));
  const used = smpMode.usedInstrumentSlots();
  assert.ok(used.length > 0, "premise: sample mode still yields a playable song");
  for (const slot of used) {
    assert.equal(smpMode.instruments[slot].newNoteAction, 1, `slot ${slot} must cut`);
  }
  const one = smpMode.instruments[1];
  assert.equal(one.defaultPan, Math.round(48 * 255 / 64), "samplewise default pan");
  assert.equal(one.vibratoSpeed, Math.round(16 * 255 / 64));
  assert.equal(one.vibratoDepth, Math.round(32 * 255 / 64));
  assert.equal(one.vibratoRate, 200);
  assert.equal(one.vibratoWaveform, 2);
  // Everything else stays neutral: no instrument record means no envelopes.
  assert.equal(one.defaultCutoff, 0xff, "no filter in sample mode");
});

/** Every {note trigger, effect opcode} pair the songs of `doc` carry, as
 *  [[note, inst, op], …]. Taud opcodes are base-36 digit values: G = 16, L = 21,
 *  S = 28. */
function triggerCells(doc) {
  const out = [];
  for (const song of doc.songs) {
    for (const pat of song.patterns) {
      for (let r = 0; r < 64; r++) {
        const o = r * 8;
        const note = pat[o] | (pat[o + 1] << 8);
        if (note < 0x20) continue;                // not a pitch trigger
        out.push({ note, inst: pat[o + 2], op: pat[o + 5], arg: pat[o + 6] | (pat[o + 7] << 8) });
      }
    }
  }
  return out;
}

test("it2taud drops the instrument byte from porta-tied rows (item 169)", () => {
  // ImpulseTracker does not reset the envelopes when a note carries both an
  // instrument number and a tone portamento; the Taud engine deliberately DOES
  // re-attack there (item 124), so the converter writes the passage the way an
  // IT author's ear expects instead — without the instrument byte. TUTE.IT
  // carries three such rows (two G, one L), and every one of them names the
  // instrument the channel is already holding, so all three lose the byte.
  const cells = triggerCells(parseTaud(convert("TUTE.IT")));
  const tied = cells.filter((c) => c.op === 16 || c.op === 21);   // G, L
  assert.ok(tied.length > 0, "premise: the file HAS porta-tied notes");
  assert.deepEqual(tied.filter((c) => c.inst !== 0), [],
    "no porta-tied trigger may still carry an instrument byte");
  // The drop is surgical: ordinary triggers keep theirs.
  assert.ok(cells.some((c) => c.op !== 16 && c.op !== 21 && c.inst !== 0),
    "plain triggers still name their instrument");
});

test("failed conversion raises and leaves the runtime reusable", () => {
  assert.throws(() => {
    runConverter(py, {
      script: "xm2taud.py",
      argv: ["/nope.xm", "/out.taud"],
      inputs: [{ path: "/nope.xm", bytes: Uint8Array.from([0, 1, 2, 3]) }],
      output: "/out.taud",
      onLog: () => {},
    });
  });
  // runtime still healthy afterwards
  const out = convert("milky.xm");
  assert.equal(parseTaud(out).kind, "taud");
});

test(".tsii + .tpif (batch mode) combine EXACTLY into the single-file conversion",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    // midi2taud directory mode → shared bank + per-song pattern image
    py.FS.mkdirTree("/mididir");
    py.FS.mkdirTree("/outdir");
    py.FS.writeFile("/mididir/M_E1M1.mid", readFileSync(importDir + "M_E1M1.mid"));
    const tpifBytes = runConverter(py, {
      script: "midi2taud.py",
      argv: ["/mididir", "/sf.sf2", "/outdir"],
      inputs: [{ path: "/sf.sf2", bytes: readFileSync(sf2Path) }],
      output: "/outdir/M_E1M1.tpif",
      onLog: () => {},
    });
    const tsiiBytes = py.FS.readFile("/outdir/sf.tsii"); // sf_stem of /sf.sf2

    const tsii = parseTaud(new Uint8Array(tsiiBytes));
    const tpif = parseTaud(new Uint8Array(tpifBytes));
    assert.equal(tsii.kind, "tsii");
    assert.equal(tpif.kind, "tpif");
    assert.equal(tpif.sampleInstImage, null);

    const combined = combineTpif(tsii, tpif);
    const single = parseTaud(convert("M_E1M1.mid")); // same flags via buildArgv
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    assert.ok(eq(combined.sampleInstImage, single.sampleInstImage), "image byte-equal");
    const cs = combined.songs[0], ss = single.songs[0];
    assert.equal(cs.patterns.length, ss.patterns.length);
    cs.patterns.forEach((p, i) => assert.ok(eq(p, ss.patterns[i]), `pattern ${i}`));
    cs.cues.forEach((c, i) => assert.deepEqual([...c], [...ss.cues[i]], `cue ${i}`));
    assert.equal(cs.bpm, ss.bpm);
    assert.equal(cs.tickRate, ss.tickRate);

    // the combined document is a full, saveable .taud
    const doc = new Document(combined);
    assert.deepEqual(doc.meta.songMeta[0], new Document(single).meta.songMeta[0]);
    const re = parseTaud(doc.toBytes());
    assert.equal(re.kind, "taud");
    assert.ok(eq(re.sampleInstImage, combined.sampleInstImage));
  });

test("sf2bank: list presets + build bank + merge into a project (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const sf2 = { path: "/sf.sf2", bytes: readFileSync(sf2Path) };

    const listOut = runConverter(py, {
      script: SF2BANK_SOURCE,
      argv: ["list", "/sf.sf2", "/out.json"],
      inputs: [sf2],
      output: "/out.json",
      onLog: () => {},
    });
    const presets = JSON.parse(Buffer.from(listOut).toString());
    assert.ok(presets.length > 100, `GeneralUser lists ${presets.length} presets`);
    assert.ok(presets.some((p) => p.name === "Grand Piano" && p.bank === 0 && p.program === 0));
    assert.ok(presets.some((p) => p.bank === 128), "has drum kits");

    const sel = JSON.stringify([[0, 0], [128, 0]]); // Grand Piano + Standard 1
    const tsii = runConverter(py, {
      script: SF2BANK_SOURCE,
      argv: ["build", "/sf.sf2", "/sel.json", "/out.tsii", "--bpm", "125"],
      inputs: [sf2, { path: "/sel.json", bytes: new TextEncoder().encode(sel) }],
      output: "/out.tsii",
      onLog: () => {},
    });
    const src = new Document(parseTaud(tsii));
    assert.equal(src.kind, "tsii");
    const topLevel = src.usedInstrumentSlots().filter((s) => s <= 255);
    assert.equal(topLevel.length, 2, "one slot per selected preset");
    assert.equal(src.instrumentName(topLevel[0]), "Grand Piano");
    assert.ok(src.instruments[topLevel[1]].isPercussion, "drum kit carries the P flag");

    // merge into a real project through the same pipeline the UI uses
    const dest = new Document(parseTaud(readFileSync(root + "test/corpus/WHEN.taud")));
    const before = Buffer.from(dest.toBytes());
    const undo = new UndoStack(dest);
    const plan = planImport(dest, src, topLevel);
    assert.ok(!plan.error, plan.error);
    undo.apply(importBankOp(plan));
    const gp = plan.slotMap.get(topLevel[0]);
    assert.equal(dest.instrumentName(gp), "Grand Piano");
    undo.undo();
    assert.ok(Buffer.from(dest.toBytes()).equals(before), "undo byte-exact");
  });

test("bnkbank: list patches + build bank + merge into a project", () => {
  const bnk = { path: "/in.bnk", bytes: IMS_BANK };

  const listOut = runConverter(py, {
    script: BNKBANK_SOURCE,
    argv: ["list", "/in.bnk", "/out.json"],
    inputs: [bnk],
    output: "/out.json",
    onLog: () => {},
  });
  const patches = JSON.parse(Buffer.from(listOut).toString());
  assert.deepEqual(patches, [{ index: 0, name: "LEAD" }, { index: 1, name: "bass" }]);

  const sel = JSON.stringify([0, 1]);
  const tsii = runConverter(py, {
    script: BNKBANK_SOURCE,
    argv: ["build", "/in.bnk", "/sel.json", "/out.tsii", "--bpm", "125"],
    inputs: [bnk, { path: "/sel.json", bytes: new TextEncoder().encode(sel) }],
    output: "/out.tsii",
    onLog: () => {},
  });
  const src = new Document(parseTaud(tsii));
  assert.equal(src.kind, "tsii");
  const topLevel = src.usedInstrumentSlots().filter((s) => s <= 255);
  assert.equal(topLevel.length, 2, "one rack slot per selected patch");
  assert.equal(src.instrumentName(topLevel[0]), "LEAD");
  assert.equal(src.instrumentName(topLevel[1]), "bass");

  // merge into a real project through the same pipeline the UI uses
  const dest = new Document(parseTaud(readFileSync(root + "test/corpus/WHEN.taud")));
  const before = Buffer.from(dest.toBytes());
  const undo = new UndoStack(dest);
  const plan = planImport(dest, src, topLevel);
  assert.ok(!plan.error, plan.error);
  undo.apply(importBankOp(plan));
  const lead = plan.slotMap.get(topLevel[0]);
  assert.equal(dest.instrumentName(lead), "LEAD");
  undo.undo();
  assert.ok(Buffer.from(dest.toBytes()).equals(before), "undo byte-exact");
});

test("midi2taud with GeneralUser-GS → parseable document (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const out = convert("M_E1M1.mid");
    const doc = new Document(parseTaud(out));
    assert.equal(doc.kind, "taud");
    assert.ok(doc.songs[0].patterns.length > 0);
    const used = doc.usedInstrumentSlots();
    assert.ok(used.length > 0);
    // E1M1 layers presets → expect at least one Metainstrument, like the
    // corpus M_E1M1.taud built by the same converter natively
    assert.ok(used.some((s) => doc.instruments[s].isMeta));

    // Item 77: the converter pins MIDI key 60 to noteVal 0x5000, and key 60 is
    // concert middle C — so it must DECLARE concert. Declaring the tracker
    // default (C9 @ 8363) would now drag the whole song 1.87 cents flat, since
    // the engine no longer ignores these fields. A4 @ 440 is also the
    // exact-identity pair, so this render is unchanged by tuning existing.
    assert.equal(doc.songs[0].tuningBaseNote, 0x5c00, "must declare A4");
    assert.equal(doc.songs[0].tuningFreq, 440, "must declare 440 Hz");
    assert.ok(Object.is(tuningRatioOf(doc.songs[0].tuningBaseNote, doc.songs[0].tuningFreq), 1.0),
      "a concert declaration must be the exact-identity tuning");
  });

// Item 159 — pattern $0000 is the index an editor hands out for a newly-added
// channel or cue, so a converted song must not have real music sitting there.
test("midi2taud reserves pattern $0000 for silence (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    for (const opts of [{}, { keepDuplicatePatterns: true }]) {
      const song = parseTaud(convert("M_E1M1.mid", opts)).songs[0];
      const p0 = song.patterns[0];
      let sounding = 0;
      for (let r = 0; r < 64; r++) {
        const o = r * 8;
        // note / instrument / effect opcode — the vol+pan bytes are 0xC0 no-ops
        // in a filler cell, so they say nothing about whether it sounds.
        if (p0[o] || p0[o + 1] || p0[o + 2] || p0[o + 5]) sounding++;
      }
      assert.equal(sounding, 0,
        `pattern $0000 must be silent (${sounding} rows carry something)`);
    }
  });

test("midi2taud --rpb pins the grid: more rows-per-beat → more rows (item 62; skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const totalRows = (bytes) =>
      new Document(parseTaud(bytes)).songs[0].patterns
        .reduce((n, p) => n + (p ? p.length : 0), 0);
    const rows2 = totalRows(convert("M_E1M1.mid", { rpb: 2 }));
    const rows16 = totalRows(convert("M_E1M1.mid", { rpb: 16 }));
    // rows = beats × rpb (a pinned rpb is not bumped), so 16 rpb yields
    // materially more rows than 2 — proof the --rpb flag reached the converter.
    assert.ok(rows2 > 0 && rows16 > 0, "both conversions produced rows");
    assert.ok(rows16 > rows2 * 2,
      `expected 16-rpb (${rows16}) to far exceed 2-rpb (${rows2})`);
  });

/** A minimal SMF-0 whose notes last only `len` MIDI ticks — the shape a
 *  sequencer writes for GM percussion, which ignores note-off. Synthesised
 *  rather than shipped as a corpus binary so the durations under test are
 *  visible right here. One beat apart, a distinct melodic pitch each, a snare
 *  alongside every one of them, and a final note the SOURCE itself writes as
 *  zero-length. */
function makeShortNoteMidi({ tpq = 480, len = 3, count = 8 } = {}) {
  const ev = [];
  const varlen = (n) => {
    const b = [n & 0x7f];
    n >>= 7;
    while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>= 7; }
    return b;
  };
  let last = 0;
  const at = (tick, ...bytes) => { ev.push(...varlen(tick - last), ...bytes); last = tick; };
  at(0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);   // 500000 µs/quarter = 120 BPM
  at(0, 0xc0, 0x00);                            // ch0  → Grand Piano
  at(0, 0xc9, 0x00);                            // ch9  → standard kit
  for (let i = 0; i < count; i++) {
    const t = i * tpq;
    at(t, 0x90, 60 + i, 100);
    at(t, 0x99, 38, 100);                       // snare, same instant
    at(t + len, 0x80, 60 + i, 0);
    at(t + len, 0x89, 38, 0);
  }
  const z = count * tpq;                        // zero-length: on and off together
  at(z, 0x90, 72, 100);
  at(z, 0x80, 72, 0);
  at(z + tpq, 0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (tpq >> 8) & 0xff, tpq & 0xff];
  const trk = [0x4d, 0x54, 0x72, 0x6b,
    (ev.length >>> 24) & 0xff, (ev.length >>> 16) & 0xff,
    (ev.length >>> 8) & 0xff, ev.length & 0xff];
  return new Uint8Array([...head, ...trk, ...ev]);
}

test("midi2taud keeps notes only a few MIDI ticks long (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    // 3 ticks at 480 PPQ is a fortieth of a fine tick on the grid the picker
    // chooses here (rpb 4 x speed 6 = 24 per beat, so 20 MIDI ticks each), so
    // every one of these notes used to round to zero length and be DROPPED —
    // this exact file converted to "MIDI contains no playable notes". The floor
    // holds anything the source gave a duration at one fine tick.
    const COUNT = 8;
    const out = runConverter(py, {
      script: "midi2taud.py",
      argv: buildArgv({ isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud" }),
      inputs: [
        { path: "/in.mid", bytes: makeShortNoteMidi({ len: 3, count: COUNT }) },
        { path: "/sf.sf2", bytes: readFileSync(sf2Path) },
      ],
      output: "/out.taud",
      onLog: () => {},
    });
    const cells = triggerCells(parseTaud(out));
    assert.equal(cells.length, COUNT * 2,
      `every 3-tick note survives: ${COUNT} melodic + ${COUNT} drum`);

    // The melodic run is eight ASCENDING pitches, one per beat — so this also
    // says the rescued notes kept their own pitch and their own place, rather
    // than being smeared onto one row.
    const notes = [...new Set(cells.map((c) => c.note))].sort((a, b) => a - b);
    assert.equal(notes.length, COUNT + 1, "8 melodic pitches + the snare's");
    const melodic = notes.slice(-COUNT);
    for (let i = 1; i < melodic.length; i++) {
      assert.ok(melodic[i] > melodic[i - 1], "the melodic pitches ascend");
    }

    // …and a note the SOURCE wrote as zero-length is still dropped: that is an
    // artefact, not a performance, and the floor deliberately does not rescue
    // it. Its key 72 is an exact octave above middle C, so it would be $6000 —
    // a ninth pitch, above all eight — and nothing may carry it.
    assert.ok(!notes.includes(0x6000),
      `the zero-length note produced no trigger (pitches ${notes.map((n) => n.toString(16))})`);
  });

/** A phrase played by hand: eight notes a beat apart on ONE pitch, every onset
 *  and every release a few ticks off the grid, plus a flam — a ninth strike of
 *  the same key two ticks after the fourth, which quantising must fold into it
 *  rather than leave overlapping. */
function makeRaggedMidi({ tpq = 480, count = 8 } = {}) {
  const ev = [];
  const varlen = (n) => {
    const b = [n & 0x7f];
    n >>= 7;
    while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>= 7; }
    return b;
  };
  const events = [];
  const at = (tick, ...bytes) => events.push([tick, bytes]);
  at(0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);   // 120 BPM
  at(0, 0xc0, 0x00);
  const slopOn = [0, 23, -17, 31, -9, 14, -28, 6];
  const slopOff = [-19, 12, 27, -31, 8, -14, 21, -6];
  for (let i = 0; i < count; i++) {
    const on = Math.max(0, i * tpq + slopOn[i]);
    at(on, 0x90, 60, 100);
    at(on + tpq - 40 + slopOff[i], 0x80, 60, 0);
  }
  // The flam: two strikes of one key 30 ticks apart, each properly closed, so
  // both survive extraction as notes in their own right. At 480 PPQ on the grid
  // the picker chooses here they are 1.5 fine ticks apart and land on the SAME
  // grid point, which is the overlap this pass has to fold.
  const f = count * tpq;
  at(f, 0x90, 60, 100);
  at(f + 20, 0x80, 60, 0);
  at(f + 30, 0x90, 60, 100);
  at(f + 400, 0x80, 60, 0);
  at((count + 1) * tpq, 0xff, 0x2f, 0x00);
  events.sort((a, b) => a[0] - b[0]);
  let last = 0;
  for (const [tick, bytes] of events) { ev.push(...varlen(tick - last), ...bytes); last = tick; }
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (tpq >> 8) & 0xff, tpq & 0xff];
  const trk = [0x4d, 0x54, 0x72, 0x6b,
    (ev.length >>> 24) & 0xff, (ev.length >>> 16) & 0xff,
    (ev.length >>> 8) & 0xff, ev.length & 0xff];
  return new Uint8Array([...head, ...trk, ...ev]);
}

/** Every cell carrying a note event, trigger or key-off, with its S $Dx delay. */
function noteCells(doc) {
  const out = [];
  for (const song of doc.songs) {
    for (const pat of song.patterns) {
      for (let r = 0; r < 64; r++) {
        const o = r * 8;
        const note = pat[o] | (pat[o + 1] << 8);
        if (note === 0) continue;
        const arg = pat[o + 6] | (pat[o + 7] << 8);
        const delay = pat[o + 5] === 0x1c && ((arg >>> 12) & 0xf) === 0xd
          ? (arg >>> 8) & 0xf : 0;
        out.push({ note, delay, keyoff: note === 1, trigger: note >= 0x20 });
      }
    }
  }
  return out;
}

test("midi2taud --quantise snaps note ENDS too, and folds the overlaps it makes (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const count = 8;
    const midi = makeRaggedMidi({ count });
    const run = (opts) => runConverter(py, {
      script: "midi2taud.py",
      argv: buildArgv({ isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2",
                        outPath: "/out.taud", ...opts }),
      inputs: [{ path: "/in.mid", bytes: midi }, { path: "/sf.sf2", bytes: readFileSync(sf2Path) }],
      output: "/out.taud",
      onLog: () => {},
    });

    // Played as written, the ragged RELEASES need sub-row delays to express —
    // that residue is the thing end-quantisation removes.
    const played = noteCells(parseTaud(run({})));
    assert.ok(played.some((c) => c.keyoff && c.delay > 0),
      "premise: the unquantised import delays some key-offs into the row");

    const snapped = noteCells(parseTaud(run({ quantise: "row" })));
    assert.deepEqual(snapped.filter((c) => c.delay > 0), [],
      "on the row grid nothing needs a delay — onsets AND key-offs land on rows");
    assert.ok(snapped.some((c) => c.keyoff), "…and the key-offs are still there");

    // The flam is a ninth strike of the SAME key two ticks after the fourth.
    // Quantised onto one grid point it is one strike, not two overlapping ones,
    // so the triggers come back to the eight notes of the phrase.
    assert.equal(played.filter((c) => c.trigger).length, count + 2,
      "premise: the phrase plus BOTH halves of the flam");
    assert.equal(snapped.filter((c) => c.trigger).length, count + 1,
      "the flam's two strikes folded into the one grid point they share");
  });

test("midi2taud --quantise puts every onset on a row (item 168; skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    // S $Dx is the ONLY way a Taud pattern can say "this note starts part way
    // through the row", so it is the exact residue of off-grid timing: a
    // conversion quantised onto the row grid cannot need one, and an
    // unquantised conversion of the same MIDI does.
    const subRowDelays = (bytes) => triggerCells(parseTaud(bytes))
      .filter((c) => c.op === 0x1c && ((c.arg >>> 12) & 0xf) === 0xd).length;

    const played = subRowDelays(convert("M_E1M1.mid"));
    assert.ok(played > 0, "premise: the unquantised import carries note delays");
    assert.equal(subRowDelays(convert("M_E1M1.mid", { quantise: "row" })), 0,
      "--quantise row leaves no sub-row timing to express");
    // "auto" picks the subdivision the onsets already use, which is never finer
    // than the row grid the picker chose for them.
    assert.equal(subRowDelays(convert("M_E1M1.mid", { quantise: "auto" })), 0,
      "--quantise auto lands on rows too");
    // …and strength 0 is a no-op, which is what makes the strength dial safe.
    assert.equal(subRowDelays(convert("M_E1M1.mid", { quantise: "row", quantiseStrength: 0 })),
      played, "strength 0 moves nothing");
  });

test("midi2taud infers the grid a mis-tempoed MIDI is really written on (item 183)", () => {
  // The canonical shape of the fault: PPQ 480 and a declared 100 BPM, but the
  // music's beat is 576 ticks — 1.2 quarter notes — so nothing in the file lines
  // up with a bar. The beat is really 0.72 s, i.e. 83⅓ BPM, and the rescale that
  // makes it one quarter note is x5/6.
  const r = realignProbe(`
ons = []
for bar in range(24):
    for b in range(4):
        t = (bar * 4 + b) * 576
        ons.append(t)
        if b % 2 == 0:
            ons.append(t + 288)
div, merged = events(480, 100, ons)
d = M.detect_musical_grid(div, merged)
out = {"bpm": d["bpm"], "ratio": d["ratio"], "beat": d["beat"],
       "coherence": d["coherence"], "deviation": d["deviation"]}
`).out;
  assert.ok(Math.abs(r.bpm - 250 / 3) < 0.01, `detected ${r.bpm} BPM, want 83.33`);
  assert.ok(Math.abs(r.ratio - 5 / 6) < 1e-4, `ratio ${r.ratio}, want 0.8333`);
  assert.ok(Math.abs(r.beat - 576) < 0.05, `beat ${r.beat} ticks, want 576`);
  // An exactly-gridded input has nothing for the fit to be uncertain about.
  assert.ok(r.coherence > 0.99, `coherence ${r.coherence}`);
  assert.ok(r.deviation < 0.01, `deviation ${r.deviation}`);
});

test("midi2taud realignment is inert on a MIDI already on its own grid (item 183)", () => {
  // The safety property the auto mode lives or dies by: a healthy file must come
  // out of --realign-tempo auto untouched, not rescaled by 0.99-something.
  const r = realignProbe(`
div, merged = events(480, 120, [i * 240 for i in range(200)])
d = M.detect_musical_grid(div, merged)
same = M.realign_tempo(div, merged, 'auto')
out = {"bpm": d["bpm"], "ratio": d["ratio"], "unchanged": same == merged}
`);
  assert.ok(Math.abs(r.out.bpm - 120) < 0.01, `detected ${r.out.bpm} BPM, want 120`);
  // The coherence sweep lands on the grid to within its own float noise, so the
  // ratio is 1 to about seven digits rather than exactly — orders of magnitude
  // inside the tolerance that decides there is nothing to do.
  assert.ok(Math.abs(r.out.ratio - 1) < 1e-5, `ratio ${r.out.ratio}, want 1`);
  assert.ok(r.out.unchanged, "a file already on the grid must not be rewritten");
  // The converter's own -v diagnostics share this stream; what must NOT be here
  // is the line that announces a rewrite to somebody who did not ask for -v.
  assert.ok(!/^note:/m.test(r.stderr), `it claimed to act: ${r.stderr}`);
});

test("midi2taud --realign-tempo BPM rescales ticks and tempo together (item 183)", () => {
  // Both halves move by the same factor, which is what keeps the performance
  // where it was in real time: the last event lands at the same second.
  const r = realignProbe(`
div, merged = events(480, 100, [i * 480 for i in range(11)])
before = merged[-1][0] / 480 * 60.0 / 100.0
out2 = M.realign_tempo(div, merged, 150.0)
tempo = [e[2][1] for e in out2 if e[2][0] == 'tempo']
after = out2[-1][0] / 480 * 60.0 / tempo[0]
out = {"lastTick": out2[-1][0], "wasLastTick": merged[-1][0], "tempo": tempo,
       "before": before, "after": after}
`).out;
  assert.deepEqual(r.tempo, [150]);
  assert.equal(r.lastTick, r.wasLastTick * 1.5);
  assert.ok(Math.abs(r.before - r.after) < 1e-9,
    `${r.before}s became ${r.after}s — the rescale must preserve real time`);
});

test("midi2taud realignment gives a tempo-less MIDI the tempo it now plays at (item 183)", () => {
  // Nothing to scale means nothing declares the new timeline's speed, so the
  // 120 BPM the file was riding by default has to be written down, scaled.
  const r = realignProbe(`
div, merged = events(480, 120, [i * 480 for i in range(11)], tempo=False)
out2 = M.realign_tempo(div, merged, 90.0)
out = {"tempos": [(e[0], e[2][1]) for e in out2 if e[2][0] == 'tempo'],
       "firstIsTempo": out2[0][2][0] == 'tempo'}
`).out;
  assert.deepEqual(r.tempos, [[0, 90]]);
  assert.ok(r.firstIsTempo, "the inserted tempo must sort ahead of the notes it governs");
});

test("midi2taud realignment refuses a MIDI with no grid at all (item 183)", () => {
  // Onsets at random intervals are not a mis-tempoed grid, they are no grid.
  // Auto has to say so and leave the timeline alone rather than invent a beat.
  const r = realignProbe(`
import random
random.seed(3)
t = 0
ons = []
for _ in range(300):
    t += random.randint(37, 611)
    ons.append(t)
div, merged = events(480, 120, ons)
d = M.detect_musical_grid(div, merged)
same = M.realign_tempo(div, merged, 'auto')
out = {"coherence": d["coherence"], "unchanged": same == merged}
`);
  assert.ok(r.out.coherence < 0.3, `coherence ${r.out.coherence} should be far from a grid`);
  assert.ok(r.out.unchanged, "a gridless MIDI must be left exactly as it was");
  assert.match(r.stderr, /no consistent grid/);
});

test("midi2taud --realign-tempo auto leaves a well-formed MIDI byte-identical (item 183; skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" }, () => {
    // The end of the same safety property, through the whole converter: E1M1
    // declares 220 BPM and means it, so asking for realignment must produce the
    // very same file as not asking.
    assert.deepEqual(convert("M_E1M1.mid", { realign: "auto" }),
                     convert("M_E1M1.mid"),
      "--realign-tempo auto must be a no-op on a MIDI whose beat IS its quarter note");
  });

test("midi2taud --no-dedup-patterns unshares patterns without changing the song (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const song = (bytes) => parseTaud(bytes).songs[0];
    const pooled = song(convert("M_E1M1.mid"));                              // default
    const unshared = song(convert("M_E1M1.mid", { keepDuplicatePatterns: true }));

    // The cue sheet is the same shape either way — only what its words POINT AT
    // changes, so walk both cue×voice grids and compare the pattern each cell
    // resolves to. Byte-identical everywhere ⇒ the song is note-for-note the same.
    assert.equal(unshared.cues.length, pooled.cues.length);
    const cellAt = (s, c, ch) => {
      const w = s.cues[c][ch] & CUE_EMPTY;
      return w === CUE_EMPTY ? "-" : Buffer.from(s.patterns[w]).toString("hex");
    };
    for (let c = 0; c < pooled.cues.length; c++) {
      for (let ch = 0; ch < pooled.cues[c].length; ch++) {
        assert.equal(cellAt(unshared, c, ch), cellAt(pooled, c, ch),
          `cue ${c} channel ${ch} differs`);
      }
    }

    // How often each pattern index is referenced. Pooling MUST produce reuse on
    // a song this repetitive (E1M1's silent columns alone repeat), and the flag
    // MUST remove all of it: one private pattern per occupied cue×voice cell.
    const refCounts = (s) => {
      const n = new Map();
      for (const words of s.cues) {
        for (const w of words) {
          const p = w & CUE_EMPTY;
          if (p !== CUE_EMPTY) n.set(p, (n.get(p) ?? 0) + 1);
        }
      }
      return n;
    };
    const pooledRefs = refCounts(pooled), unsharedRefs = refCounts(unshared);
    assert.ok([...pooledRefs.values()].some((n) => n > 1),
      "the default build should share at least one pattern between cues");
    assert.deepEqual([...unsharedRefs.values()].filter((n) => n > 1), [],
      "--no-dedup-patterns must leave no pattern referenced twice");
    // Same number of occupied cells, spread over strictly more patterns.
    assert.equal(unsharedRefs.size, [...pooledRefs.values()].reduce((a, b) => a + b, 0));
    assert.ok(unshared.patterns.length > pooled.patterns.length,
      `unshared (${unshared.patterns.length}) should exceed pooled (${pooled.patterns.length})`);
    assert.ok(unshared.patterns.length <= NUM_PATTERNS_MAX);
  });

test("midi2taud keeps every zone by default; --trim-unused-patches drops the untriggered ones (item 75; skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const patchCount = (bytes) => {
      const doc = new Document(parseTaud(bytes));
      return doc.usedInstrumentSlots()
        .reduce((n, s) => n + (doc.instruments[s].extraPatches?.length ?? 0), 0);
    };
    const full = convert("M_E1M1.mid");                          // default: no flag
    const trimmed = convert("M_E1M1.mid", { trimPatches: true });
    const nFull = patchCount(full), nTrim = patchCount(trimmed);
    // The default now carries each preset's whole zone map, so it must hold
    // strictly more patches than the trim-to-triggered build.
    assert.ok(nTrim > 0, "the trimmed build still has patches");
    assert.ok(nFull > nTrim, `default (${nFull}) should keep more patches than trimmed (${nTrim})`);
    // The extra patches are INERT for this song: the notes it actually plays are
    // untriggered-patch-free either way, so both banks must render identically.
    const render = (bytes) => {
      const doc = new Document(parseTaud(bytes));
      const eng = new TaudEngine();
      loadIntoEngine(eng, doc.toRenderable(0), 0);
      eng.setMasterVolume(0, 255);
      eng.setCuePosition(0, 0);
      eng.play(0);
      const out = new Uint8Array(TRACKER_CHUNK * 2);
      const acc = [];
      // ~2 s of audio: enough for every voice to speak, cheap to compare.
      for (let i = 0; i < 500; i++) { eng.renderChunk(0, out); acc.push(...out); }
      return acc;
    };
    assert.deepEqual(render(full), render(trimmed),
      "untriggered patches must not change what the song sounds like");
  });

// ── stereo samples (item 90) ───────────────────────────────────────────────

test("it2taud keeps an IT stereo sample as a stereo pair, --mono-samples folds it", () => {
  // TUTE-stereo.it is TUTE.IT with sample 1 ("Low Strings") turned into a
  // stereo sample whose right channel is the left inverted about the DC centre.
  const stereoDoc = new Document(parseTaud(convert("TUTE-stereo.it")));
  const monoDoc = new Document(parseTaud(convert("TUTE.IT")));

  const list = stereoDoc.sampleList();
  const pair = list.filter(isStereoSample);
  assert.equal(pair.length, 1, "exactly one sample came through stereo");
  assert.equal(pair[0].name, "Low Strings");
  assert.deepEqual(sampleSpans(pair[0]).length, 2);

  // Both channels are pooled, and they genuinely differ.
  const [l, r] = sampleSpans(pair[0]);
  let diff = 0;
  for (let i = 0; i < pair[0].len; i++) {
    if (stereoDoc.sampleBin[l.ptr + i] !== stereoDoc.sampleBin[r.ptr + i]) diff++;
  }
  assert.ok(diff > pair[0].len * 0.9, `channels must differ (${diff}/${pair[0].len})`);

  // The census still names one sample per pair — same list as the mono file.
  assert.deepEqual(list.map((s) => s.name), monoDoc.sampleList().map((s) => s.name));

  // The instrument that plays it carries an 's' patch, and it sounds in stereo.
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(convert("TUTE-stereo.it")));
  const slot = stereoDoc.usedInstrumentSlots()
    .find((s) => (stereoDoc.instruments[s].extraPatches ?? []).some(patchIsStereo));
  assert.ok(slot, "some instrument carries the stereo patch");
  eng.setMasterVolume(0, 255);
  eng.jamNote(0, 0, 0x5000, slot);
  assert.equal(eng.playheads[0].trackerState.voices[0].activeChanCount, 2);
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let spread = 0, level = 0, n = 0;
  for (let c = 0; c < 20; c++) {
    eng.renderChunk(0, out);
    const ts = eng.playheads[0].trackerState;
    for (let i = 0; i < ts.mixLeft.length; i++) {
      spread += Math.abs(ts.mixLeft[i] - ts.mixRight[i]);
      level += Math.abs(ts.mixLeft[i]);
      n++;
    }
  }
  assert.ok(level / n > 0.001, "the note must sound");
  assert.ok(spread / n > level / n * 0.5, "left and right must differ");

  // --mono-samples reproduces the old downmix: no stereo, no extra pool bytes.
  const folded = new Document(parseTaud(runConverter(py, {
    script: "it2taud.py",
    argv: ["/in.it", "/out.taud", "-v", "--mono-samples"],
    inputs: [{ path: "/in.it", bytes: readFileSync(importDir + "TUTE-stereo.it") }],
    output: "/out.taud",
    onLog: () => {},
  })));
  assert.equal(folded.sampleList().filter(isStereoSample).length, 0);
});

test("midi2taud --stereo-samples imports SF2 pairs as stereo (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const run = (extra) => new Document(parseTaud(runConverter(py, {
      script: "midi2taud.py",
      argv: buildArgv({
        isMidi: true, inPath: "/in.mid", sf2Path: "/sf.sf2", outPath: "/out.taud",
        ...extra,
      }),
      inputs: [
        { path: "/in.mid", bytes: readFileSync(importDir + "M_E1M1.mid") },
        { path: "/sf.sf2", bytes: readFileSync(sf2Path) },
      ],
      output: "/out.taud",
      onLog: () => {},
    })));
    const poolBytes = (doc) =>
      doc.sampleList().reduce((n, e) => n + e.len * sampleSpans(e).length, 0);

    const mono = run({});
    assert.equal(mono.sampleList().filter(isStereoSample).length, 0,
      "mono stays the default for MIDI imports");
    const stereo = run({ stereoSamples: true });
    // Whether GeneralUser's presets use stereo pairs at all is the SF2's
    // business; the invariants are that the flag never loses samples, never
    // shrinks the pool, and that any stereo entry is a genuine two-span pair
    // the engine will play as such.
    assert.equal(stereo.sampleList().length, mono.sampleList().length);
    assert.ok(poolBytes(stereo) >= poolBytes(mono));
    for (const e of stereo.sampleList().filter(isStereoSample)) {
      assert.equal(sampleSpans(e).length, 2);
      assert.notEqual(e.chanPtrs[0], e.ptr);
    }
    for (const slot of stereo.usedInstrumentSlots()) {
      for (const p of stereo.instruments[slot].extraPatches ?? []) {
        if (patchIsStereo(p)) assert.equal(p.chanPtrs.length, 1);
      }
    }
  });

test("sf2bank --stereo doubles the pool and marks the samples stereo (skips without the SF2)",
  { skip: !existsSync(sf2Path) && "GeneralUser-GS.sf2 not present in repo root" },
  () => {
    const sf2 = { path: "/sf.sf2", bytes: readFileSync(sf2Path) };
    const sel = JSON.stringify([[0, 0]]); // Grand Piano
    const build = (extra) => new Document(parseTaud(runConverter(py, {
      script: SF2BANK_SOURCE,
      argv: ["build", "/sf.sf2", "/sel.json", "/out.tsii", "--bpm", "125", ...extra],
      inputs: [sf2, { path: "/sel.json", bytes: new TextEncoder().encode(sel) }],
      output: "/out.tsii",
      onLog: () => {},
    })));
    const poolBytes = (doc) =>
      doc.sampleList().reduce((n, e) => n + e.len * sampleSpans(e).length, 0);

    const mono = build([]);
    const stereo = build(["--stereo"]);
    assert.equal(mono.sampleList().filter(isStereoSample).length, 0,
      "mono is still the default (item 90.1 is opt-in)");
    // GeneralUser's Grand Piano may or may not be built from stereo pairs; the
    // invariant either way is that --stereo never LOSES samples and never
    // shrinks the pool, and that any stereo entry costs exactly two spans.
    assert.equal(stereo.sampleList().length, mono.sampleList().length);
    assert.ok(poolBytes(stereo) >= poolBytes(mono));
    for (const e of stereo.sampleList().filter(isStereoSample)) {
      assert.equal(sampleSpans(e).length, 2);
      assert.notEqual(e.chanPtrs[0], e.ptr);
    }
  });

// ── AdLib / Iyagi Music Sound (item 171) ─────────────────────────────────────
//
// An .ims stores nothing but nine-character patch NAMES, so both halves are
// built here rather than committed: the format is small enough that writing it
// out documents it, and a fixture pair would only be two more opaque blobs.

test("converterFor knows which formats need an instrument bank", () => {
  assert.equal(converterFor("SONG.IMS").script, "ims2taud.py");
  assert.ok(converterFor("SONG.IMS").needsBank);
  assert.ok(!converterFor("song.xm").needsBank);
  assert.ok(!converterFor("song.mid").needsBank);
});

test("buildArgv passes AdLib banks most-specific-first", () => {
  assert.deepEqual(
    buildArgv({ needsBank: true, inPath: "/in.ims", outPath: "/out.taud",
                bankPaths: ["/bank0.bnk", "/bank1.bnk"] }),
    ["/in.ims", "/out.taud", "-v", "-b", "/bank0.bnk", "-b", "/bank1.bnk"]);
  // No bank paths is still a legal argv — the converter warns and goes silent.
  assert.deepEqual(buildArgv({ needsBank: true, inPath: "/in.ims", outPath: "/out.taud" }),
    ["/in.ims", "/out.taud", "-v"]);
});

test("ims2taud: an AdLib song plus its bank → a playable FM-rack document", () => {
  const bytes = convert("song.ims", { bytes: IMS_SONG, banks: [IMS_BANK] });
  const doc = parseTaud(bytes);
  assert.equal(doc.kind, "taud");
  assert.equal(doc.songs.length, 1);
  const song = doc.songs[0];
  // Melodic mode is nine OPL voices, and channel IS voice in this format.
  assert.equal(song.numVoices, 9);
  // Concert pitch, declared the one way the engine reads as an exact identity:
  // A4 @ 440 renders without a bit disturbed, so the song is an ordinary
  // 12-TET one to work on rather than one tuned 0.6 cents off to the chip.
  assert.equal(song.tuningBaseNote, 0x5c00);
  assert.equal(song.tuningFreq, 440);
  assert.equal(tuningRatioOf(song.tuningBaseNote, song.tuningFreq), 1.0);
  // The Johab title survives as the project name — through the \uHHHH escape
  // convention names ride, since these titles are Korean by nature.
  assert.equal(unescapeName(doc.meta.projectName), "검은");

  // Every patch the song names becomes a type-4 FM rack whose operators live
  // in the auxiliary bin, and whose algorithm verifies (a rack whose program
  // does not verify is silent, so a parsed fmProgram is the real check).
  const d = new Document(doc);
  const insts = d.instruments;
  const racks = insts.filter((inst) => inst && inst.isMeta && inst.metaType === 4);
  assert.ok(racks.length >= 2, `expected a rack per patch, got ${racks.length}`);
  for (const rack of racks) {
    assert.ok(rack.fmProgram !== null && rack.fmProgram.length > 0);
    assert.ok(rack.metaLayers.length >= 2);
    for (const op of rack.metaLayers) assert.ok(op.instIdx >= 256, "operators live in the aux bin");
  }
});

test("ims2taud: the converted song actually sounds", () => {
  const bytes = convert("song.ims", { bytes: IMS_SONG, banks: [IMS_BANK] });
  const doc = parseTaud(bytes);
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc, 0);
  eng.play(0);
  const buf = new Float32Array(TRACKER_CHUNK * 2);
  let peak = 0;
  for (let i = 0; i < 400; i++) {
    eng.renderChunk(0, buf);
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak > 0.02, `converted IMS rendered silence (peak ${peak})`);
});

test("ims2taud: an unresolved patch name is a silent slot, not a failure", () => {
  const song = makeIms({ title: JOHAB_TITLE, events: IMS_EVENTS,
                         names: ["NOSUCH", "ALSONOT"] });
  const bytes = convert("song.ims", { bytes: song, banks: [IMS_BANK] });
  const doc = parseTaud(bytes);
  assert.equal(doc.songs.length, 1);
});

test("ims2taud gives a cue a whole number of bars", () => {
  // A pattern holds 64 rows and a bar of twelve-rows-a-beat 4/4 is 48, so a flat
  // 64-row cue would straddle every bar line and the song would be unusable to
  // remix. The cue plays 48 and says so with LEN; the last one says "halt at 48",
  // which is one instruction rather than two sharing a cue's two words.
  const doc = parseTaud(convert("song.ims", { bytes: IMS_SONG_12RPB, banks: [IMS_BANK] }));
  const song = doc.songs[0];
  assert.equal(doc.meta.songMeta[0].beatPri, 12, "twelve rows to the beat");
  assert.equal(doc.meta.songMeta[0].beatSec, 48, "…and forty-eight to the bar");
  assert.equal(doc.meta.songMeta[0].notation, 120, "displayed as 12-TET");
  const LEN_48 = (0x02 << 8) | 47;               // rows − 1
  const HALT_AT_48 = (0x01 << 8) | 0x40 | 48;    // the row count itself
  const words = song.cues.map((c) => cueInstructionWords(c)[0]);
  assert.ok(words.length >= 2, `expected several cues, got ${words.length}`);
  for (const w of words.slice(0, -1)) assert.equal(w, LEN_48);
  assert.equal(words[words.length - 1], HALT_AT_48);
});

test("…and leaves a 64-row cue alone when the bar already fits", () => {
  // Eight rows a beat is 32 to the bar: two whole bars fit a pattern, so there
  // is nothing to shorten and no LEN to write.
  const doc = parseTaud(convert("song.ims", { bytes: IMS_SONG, banks: [IMS_BANK] }));
  assert.equal(doc.meta.songMeta[0].beatSec, 32);
  const words = doc.songs[0].cues.map((c) => cueInstructionWords(c)[0]);
  for (const w of words.slice(0, -1)) assert.equal(w, 0, "no LEN on a full-length cue");
  assert.equal(words[words.length - 1], 0x0100, "a plain HALT ends it");
});
