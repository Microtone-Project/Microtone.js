#!/usr/bin/env node
// Rebuild the "Huygens' Clock" demo from source:
//
//   node tools/huygens-clock/make.mjs [out.taud] [-v]
//
// (from microtone-worker/; the default output is assets/demo_projects/Huygens_clock.taud).
// Afterwards update that row's `bytes` in assets/demo_projects/demos.json and
// re-record its golden digests: node tools/make-golden.js Huygens_clock.
//
// Steps: the bank is built from the bundled GeneralUser GS soundfont by the
// app's own SF2 driver (src/convert/sf2bank.py, run with the local python3);
// song.mjs composes into per-lane event maps; lib.mjs compiles those into
// patterns and cues; the Ixmp zones the song never reaches are pruned exactly
// as the app's Cleanup does; the marimba's release is shortened; every zone the
// song plays is re-tuned onto the 31-TET grid (retune.mjs); the mastering chain
// and the texts come from meta.mjs; the save is Zstandard, as the app's own.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { parseTaud } from "../../core/format/taud-parse.js";
import { buildMasteringSection } from "../../core/format/mastering-section.js";
import { defaultMastering } from "../../core/engine/mastering.js";
import { parsePatchesBlob, writePatchesBlob } from "../../core/engine/inst.js";
import { ZSTD_LEVEL_SAVE } from "../../core/format/zstd.js";
import { SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { Document } from "../../src/doc/document.js";
import { planIxmpCleanup, encodeNameTable } from "../../src/doc/cleanup.js";
import { cleanupBankOp } from "../../src/doc/ops.js";
import { buildIxmpSection } from "../../src/doc/bankmerge.js";

import { compile, lanes, SPEED } from "./lib.mjs";
import { sectionOfCue } from "./song.mjs";
import { retune, usesFromLanes } from "./retune.mjs";
import {
  TITLE, FILE, COMPOSER, COPYRIGHT, MESSAGE, MASTER, BPM, GLOBAL_VOLUME, MIXING_VOLUME,
  INST_NAMES, PRESETS, LAYER_MIX,
} from "./meta.mjs";

const APP = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes("-v");
const outPath = args.find((a) => !a.startsWith("-")) ?? join(APP, "assets/demo_projects", FILE);

// ── the bank ────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "huygens-clock-"));
let bank;
try {
  const sf2 = join(tmp, "GeneralUser-GS.sf2");
  writeFileSync(sf2, gunzipSync(readFileSync(join(APP, "assets/GeneralUser-GS.taud.sf2.gz"))));
  writeFileSync(join(tmp, "presets.json"), JSON.stringify(PRESETS));
  // --bpm: the SF2 release times become per-tick fadeouts at the song's tempo.
  execFileSync("python3", [join(APP, "src/convert/sf2bank.py"), "build", sf2,
    join(tmp, "presets.json"), join(tmp, "bank.tsii"), "--bpm", String(BPM)], {
    env: { ...process.env, PYTHONPATH: join(APP, "vendor/converters"), PYTHONDONTWRITEBYTECODE: "1" },
    stdio: verbose ? "inherit" : "ignore",
  });
  bank = parseTaud(readFileSync(join(tmp, "bank.tsii")));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── the song ────────────────────────────────────────────────────────────────
const { patterns, cues, names } = compile(sectionOfCue);

// Every lane's pan (S $80xx) on the song's first row. A lane that plays nothing
// in cue 0 gets a pattern holding only that; one whose cue-0 pattern is shared
// with a later cue gets its own copy, so the pan is set once.
for (let li = 0; li < lanes.length; li++) {
  const cue0 = cues[0];
  let p = cue0[li] & 0x7fff;
  if (p === 0x7fff) {
    const bytes = new Uint8Array(512);
    for (let r = 0; r < 64; r++) { bytes[r * 8 + 3] = 0xc0; bytes[r * 8 + 4] = 0xc0; }
    p = patterns.length;
    patterns.push(bytes);
    names.push(`${lanes[li].label} setup`);
    cue0[li] = (cue0[li] & 0x8000) | p;
  } else if (cues.some((w, c) => c > 0 && w.some((x) => (x & 0x7fff) === p))) {
    patterns.push(patterns[p].slice());
    names.push(`${names[p]} (setup)`);
    p = patterns.length - 1;
    cue0[li] = (cue0[li] & 0x8000) | p;
  }
  const bytes = patterns[p];
  if (bytes[5] !== 0) throw new Error(`lane ${lanes[li].id}: row 0 of the song already carries an effect`);
  const arg = 0x8000 | lanes[li].pan;
  bytes[5] = 28; // S
  bytes[6] = arg & 0xff; bytes[7] = arg >>> 8;
}

const enc = new TextEncoder();
const str = (t) => enc.encode(t);
/** sMet for song 0: 31-TET notation (310), beat bands every eighth and every bar (2/14). */
function songMeta() {
  const sub = [310 & 0xff, 310 >> 8, 2, 14, ...str(TITLE), 0, ...str(COMPOSER), 0, ...str(COPYRIGHT), 0];
  return Uint8Array.from([0, sub.length & 0xff, (sub.length >> 8) & 0xff, 0, 0, ...sub]);
}
const sectionOf = (doc, f) => doc.projSections.find((s) => s.fourcc === f)?.payload;

const inam = new TextDecoder().decode(sectionOf(bank, "INam")).split("\x1e");
for (const [slot, name] of Object.entries(INST_NAMES)) inam[Number(slot)] = name;

const master = { ...defaultMastering(), ...MASTER };
const doc = new Document({
  kind: "taud",
  fmtVer: 2,
  is64Channel: false,
  signature: "Microtone Demo",
  sampleInstImage: bank.sampleInstImage,
  songs: [{
    numVoices: lanes.length, bpm: BPM, tickRate: SPEED,
    tuningBaseNote: 0x5c00, tuningFreq: 440, // A4 = 440 Hz
    globalFlags: 0, globalVolume: GLOBAL_VOLUME, mixingVolume: MIXING_VOLUME, surroundModel: 0,
    patterns, cues,
  }],
  projSections: [
    { fourcc: "PNam", payload: str(TITLE) },
    { fourcc: "PCom", payload: str(COMPOSER) },
    { fourcc: "PCpr", payload: str(COPYRIGHT) },
    { fourcc: "PMsg", payload: str(MESSAGE) },
    { fourcc: "INam", payload: encodeNameTable(inam) },
    { fourcc: "SNam", payload: sectionOf(bank, "SNam") },
    { fourcc: "pNam", payload: encodeNameTable(names) },
    { fourcc: "sMet", payload: songMeta() },
    { fourcc: "Ixmp", payload: sectionOf(bank, "Ixmp") },
    { fourcc: "sMst", payload: buildMasteringSection({ 0: master }) },
  ],
  ixmp: bank.ixmp,
  meta: { projectName: TITLE, songMeta: {}, mastering: { 0: master } },
});

// ── the instruments ─────────────────────────────────────────────────────────
// Drop every zone nothing in the song can reach — the app's own Ixmp cleanup.
const samplesBefore = doc.sampleList().length;
const plan = planIxmpCleanup(doc);
if (!plan.noop) cleanupBankOp(plan).apply(doc);

// The marimba strikes eight notes a second, and the SoundFont lets a displaced
// stroke fade for up to 2.4 s: twenty overlapping tails, most of them inaudible
// under the next strokes, and the heaviest thing in the song to render. Give
// every marimba zone at least the fade its upper register has (~0.9 s).
{
  const MIN_FADE = 24;
  const MARIMBA = 4;
  const layers = new Set(doc.instruments[MARIMBA].metaLayers.map((l) => l.instIdx & 0x3ff));
  for (const e of doc.ixmp) {
    if (!layers.has(e.instId & 0x3ff)) continue;
    const zones = parsePatchesBlob(e.blob);
    for (const z of zones) if (z.hasExtra && z.fadeoutStep < MIN_FADE) z.fadeoutStep = MIN_FADE;
    e.blob = writePatchesBlob(zones);
  }
  doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
  // …and each layer's own record, for zones that carry no fade of their own
  // (bytes 172–173: the low byte, then the high bits in the low nibble).
  for (const slot of layers) {
    const rec = doc.sampleInstImage.subarray(SAMPLEBIN_SIZE + slot * 256, SAMPLEBIN_SIZE + (slot + 1) * 256);
    if ((rec[172] | ((rec[173] & 0x0f) << 8)) < MIN_FADE) { rec[172] = MIN_FADE; rec[173] &= 0xf0; }
  }
  doc._resetInstrumentCache();
}

// The layer mix levels (meta.mjs), written into each metainstrument's layer table.
for (const [key, octet] of Object.entries(LAYER_MIX)) {
  const slot = Number(key);
  const inst = doc.instruments[slot];
  if (!inst.isMeta) throw new Error(`slot ${slot}: not a metainstrument`);
  const rec = doc.sampleInstImage.subarray(SAMPLEBIN_SIZE + slot * 256, SAMPLEBIN_SIZE + (slot + 1) * 256);
  for (const l of inst.metaLayers) rec[l.rawOffset + 1] = octet;
}
doc._resetInstrumentCache();

// Every zone the song plays, onto the 31-TET grid. The drum kit is left alone.
const report = retune(doc, usesFromLanes(lanes, new Set([1])), { passes: 3, log: verbose ? console.log : () => {} });
const worst = report.reduce((m, r) => Math.max(m, Math.abs(r.cents)), 0);

const bytes = await doc.toSaveBytes(ZSTD_LEVEL_SAVE);
writeFileSync(outPath, bytes);
console.log(`${outPath}: ${bytes.length} bytes — ${lanes.length} lanes, ${patterns.length} patterns, ` +
  `${cues.length} cues; samples ${samplesBefore} → ${doc.sampleList().length} ` +
  `(${plan.removedPatches ?? 0} zones pruned); ${report.length} zone groups re-tuned, ` +
  `worst ${worst.toFixed(1)} cents from the grid`);
