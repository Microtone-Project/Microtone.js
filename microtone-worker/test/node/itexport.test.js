// Impulse Tracker export (item 268) — src/convert/itexport.js, the inverse of
// it2taud.py. The strong test is the FIXPOINT: a project exported, imported
// back by it2taud (under the vendored Pyodide, as convert.test.js runs it) and
// exported again gives the same bytes — every mapping inverts the importer's,
// rounding included. The rest build small projects by hand and check one rule
// each: microtones as detuned samples on per-key variants, a tuning off
// standard pitch, volume layers, the effect and column mapping, the cue sheet,
// envelopes, the bounce of an OPL instrument, and the two prerequisites.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "../../vendor/pyodide/pyodide.js";
import {
  CONVERTER_SOURCES, loadConverterRuntime, runConverter, buildArgv,
} from "../../src/convert/convert-core.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { SAMPLEINST_SIZE, SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { makeInstPatch, writePatchesBlob } from "../../core/engine/inst.js";
import { minifloatFromDouble } from "../../core/engine/minifloat.js";
import { tuningRatioOf } from "../../core/engine/tables.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp } from "../../src/doc/ops.js";
import { planCreateOpl } from "../../src/doc/bankmerge.js";
import { defaultOplRecord } from "../../src/doc/opledit.js";
import { exportItSong, exportItSongs, itFileName } from "../../src/convert/itexport.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// ── projects built by hand ──────────────────────────────────────────────────

const EMPTY_CUE = 0x7fff;
const C4 = 0x5000;
const SEMI = 4096 / 12;
const note = (semis) => Math.round(C4 + semis * SEMI);
const cents = (c) => Math.round(C4 + (c * 4096) / 1200);
const SINE = Uint8Array.from({ length: 64 }, (_, i) => 128 + Math.round(100 * Math.sin((2 * Math.PI * i) / 64)));
const SAW = Uint8Array.from({ length: 48 }, (_, i) => 28 + i * 4);

/**
 * An envelope's LOOP word, SUSTAIN word and 25 nodes for a record: `nodes` is
 * [[value, seconds to the next node], …], the last node's time ignored.
 */
function envelope({ nodes, loop = null, sus = null, carry = false, filter = false }) {
  let lw = 0x2000;
  if (loop) lw |= 0x20 | (loop[0] << 8) | loop[1];
  if (carry) lw |= 0x40;
  if (filter) lw |= 0x80;
  const sw = sus ? 0x20 | (sus[0] << 8) | sus[1] : 0;
  const pts = nodes.map(([v, s], i) => [v, i < nodes.length - 1 ? minifloatFromDouble(s) : 0]);
  return { lw, sw, pts };
}

/**
 * A Document with `patterns` (index → {row: cell}) and `cues` (each a list of
 * pattern indices, lane by lane; `inst` an instruction word). A cell is
 * {note, inst, vol: [sel, value], pan: [sel, value], fx, arg}. An instrument
 * is {slot, data, rate, loop, sustain, pingpong, dnv, bytes: {offset: value},
 * vol/pan/pf: envelope()}; `ixmp` is {slot: [patch fields]}, each patch's
 * `data` written into the pool as well.
 */
function project({ patterns = {}, cues = [], flags = 0, bpm = 125, tick = 6,
  tuning = [0xa000, 8363], instruments = [], fmt = 2, ixmp = {}, name = "hand-built" } = {}) {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  let ptr = 0;
  const put = (data) => { image.set(data, ptr); ptr += data.length; return ptr - data.length; };
  for (const s of instruments) {
    const at = SAMPLEBIN_SIZE + s.slot * 256;
    const dv = new DataView(image.buffer, at, 256);
    const rec = image.subarray(at, at + 256);
    dv.setUint32(0, put(s.data), true);
    dv.setUint16(4, s.data.length, true);
    dv.setUint16(6, s.rate ?? 8363, true);
    dv.setUint16(10, s.loop?.[0] ?? 0, true);
    dv.setUint16(12, s.loop?.[1] ?? 0, true);
    rec[14] = (s.loop ? (s.pingpong ? 2 : 1) : 0) | (s.sustain ? 4 : 0);
    dv.setUint16(15, 0x2020, true);   // the importer's flat, present volume envelope
    for (let i = 0; i < 25; i++) { rec[21 + 2 * i] = 63; rec[71 + 2 * i] = 0x80; rec[121 + 2 * i] = 0x80; }
    rec[171] = 0xff;
    rec[177] = 0x80;
    dv.setUint16(178, C4, true);
    rec[182] = 0xff;
    rec[183] = 0xff;
    rec[186] = 1;                       // NNA: note cut
    rec[196] = s.dnv ?? 0xff;
    const env = (e, loopAt, nodesAt, susAt) => {
      if (!e) return;
      dv.setUint16(loopAt, e.lw, true);
      dv.setUint16(susAt, e.sw, true);
      e.pts.forEach(([v, o], i) => { rec[nodesAt + 2 * i] = v; rec[nodesAt + 2 * i + 1] = o; });
      for (let i = e.pts.length; i < 25; i++) { rec[nodesAt + 2 * i] = e.pts[e.pts.length - 1][0]; rec[nodesAt + 2 * i + 1] = 0; }
    };
    env(s.vol, 15, 21, 189);
    env(s.pan, 17, 71, 191);
    env(s.pf, 19, 121, 193);
    for (const [o, v] of Object.entries(s.bytes ?? {})) rec[Number(o)] = v;
  }
  const ixmpEntries = Object.entries(ixmp).map(([slot, list]) => {
    const patches = list.map(({ data, ...f }) => makeInstPatch({ samplePtr: put(data), sampleLength: data.length, ...f }));
    return { instId: Number(slot), count: patches.length, blob: writePatchesBlob(patches) };
  });
  const npat = Math.max(-1, ...Object.keys(patterns).map(Number)) + 1;
  const pats = [];
  for (let p = 0; p < npat; p++) {
    const bytes = new Uint8Array(512);
    for (let r = 0; r < 64; r++) { bytes[r * 8 + 3] = 0xc0; bytes[r * 8 + 4] = 0xc0; }
    for (const [row, c] of Object.entries(patterns[p] ?? {})) {
      const o = Number(row) * 8;
      bytes[o] = (c.note ?? 0) & 0xff;
      bytes[o + 1] = ((c.note ?? 0) >> 8) & 0xff;
      bytes[o + 2] = c.inst ?? 0;
      if (c.vol) bytes[o + 3] = (c.vol[0] << 6) | c.vol[1];
      if (c.pan) bytes[o + 4] = (c.pan[0] << 6) | c.pan[1];
      bytes[o + 5] = c.fx ?? 0;
      bytes[o + 6] = (c.arg ?? 0) & 0xff;
      bytes[o + 7] = ((c.arg ?? 0) >> 8) & 0xff;
    }
    pats.push(bytes);
  }
  const cueWords = (cues.length ? cues : [[]]).map((cue) => {
    const lanes = Array.isArray(cue) ? cue : cue.lanes;
    const words = new Uint16Array(64).fill(EMPTY_CUE);
    lanes.forEach((p, ch) => { if (p !== null) words[ch] = p; });
    const w = cue.inst ?? 0;
    for (let k = 0; k < 16; k++) words[k] = (words[k] & 0x7fff) | (((w >> k) & 1) << 15);
    return words;
  });
  return new Document({
    kind: "taud", fmtVer: fmt, is64Channel: false, signature: "Microtone.js  ",
    sampleInstImage: image,
    songs: [{
      numVoices: 32, bpm, tickRate: tick, tuningBaseNote: tuning[0], tuningFreq: tuning[1],
      globalFlags: flags, globalVolume: 255, mixingVolume: 180,
      patterns: pats, cues: cueWords,
    }],
    projSections: [], ixmp: ixmpEntries,
    meta: { projectName: name, songMeta: {} },
  });
}

const inst1 = { slot: 1, data: SINE, loop: [0, 64] };

// ── reading a module back ───────────────────────────────────────────────────

function readIt(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const str = (o, n) => {
    let s = "";
    for (let i = 0; i < n && bytes[o + i] !== 0; i++) s += String.fromCharCode(bytes[o + i]);
    return s;
  };
  const ordNum = u16(0x20), insNum = u16(0x22), smpNum = u16(0x24), patNum = u16(0x26);
  let o = 0xc0 + ordNum;
  const ptrs = (n) => Array.from({ length: n }, () => { o += 4; return u32(o - 4); });
  const insP = ptrs(insNum), smpP = ptrs(smpNum), patP = ptrs(patNum);
  const env = (p) => ({
    flags: bytes[p], num: bytes[p + 1], lpb: bytes[p + 2], lpe: bytes[p + 3], slb: bytes[p + 4], sle: bytes[p + 5],
    nodes: Array.from({ length: bytes[p + 1] }, (_, i) => [dv.getInt8(p + 6 + i * 3), u16(p + 7 + i * 3)]),
  });
  const unpack = (p) => {
    const rows = u16(p + 2);
    const grid = Array.from({ length: rows }, () => Array.from({ length: 64 }, () => ({ note: -1, inst: 0, vc: -1, fx: 0, arg: 0 })));
    const mask = new Array(64).fill(0);
    const last = Array.from({ length: 64 }, () => ({ note: -1, inst: 0, vc: -1, fx: 0, arg: 0 }));
    let q = p + 8, row = 0;
    while (row < rows) {
      const cv = bytes[q++];
      if (cv === 0) { row++; continue; }
      const ch = (cv - 1) & 63;
      if (cv & 0x80) mask[ch] = bytes[q++];
      const m = mask[ch], c = grid[row][ch], l = last[ch];
      if (m & 1) l.note = bytes[q++];
      if (m & 2) l.inst = bytes[q++];
      if (m & 4) l.vc = bytes[q++];
      if (m & 8) { l.fx = bytes[q++]; l.arg = bytes[q++]; }
      if (m & 0x11) c.note = l.note;
      if (m & 0x22) c.inst = l.inst;
      if (m & 0x44) c.vc = l.vc;
      if (m & 0x88) { c.fx = l.fx; c.arg = l.arg; }
    }
    return grid;
  };
  return {
    title: str(4, 26), flags: u16(0x2c), special: u16(0x2e), gv: bytes[0x30], mv: bytes[0x31],
    speed: bytes[0x32], tempo: bytes[0x33], chnPan: [...bytes.subarray(0x40, 0x80)],
    message: str(u32(0x38), u16(0x36)),
    orders: [...bytes.subarray(0xc0, 0xc0 + ordNum)],
    instruments: insP.map((p) => ({
      nna: bytes[p + 0x11], dct: bytes[p + 0x12], dca: bytes[p + 0x13], fadeout: u16(p + 0x14),
      pps: dv.getInt8(p + 0x16), ppc: bytes[p + 0x17], gbv: bytes[p + 0x18], dfp: bytes[p + 0x19],
      rv: bytes[p + 0x1a], rp: bytes[p + 0x1b], name: str(p + 0x20, 26), ifc: bytes[p + 0x3a], ifr: bytes[p + 0x3b],
      keyboard: Array.from({ length: 120 }, (_, k) => [bytes[p + 0x40 + 2 * k], bytes[p + 0x41 + 2 * k]]),
      env: [env(p + 0x130), env(p + 0x182), env(p + 0x1d4)],
    })),
    samples: smpP.map((p) => ({
      gvl: bytes[p + 0x11], flags: bytes[p + 0x12], vol: bytes[p + 0x13], name: str(p + 0x14, 26),
      dfp: bytes[p + 0x2f], length: u32(p + 0x30), loopBeg: u32(p + 0x34), loopEnd: u32(p + 0x38),
      c5: u32(p + 0x3c), susBeg: u32(p + 0x40), susEnd: u32(p + 0x44), ptr: u32(p + 0x48),
      vis: bytes[p + 0x4c], vid: bytes[p + 0x4d], vir: bytes[p + 0x4e], vit: bytes[p + 0x4f],
    })),
    patterns: patP.map(unpack),
  };
}

const codes = (list) => list.map((f) => f.code).sort();
const L = (c) => c.charCodeAt(0) - 64;
/** The sample a key plays on IT instrument `n` (1-based). */
const sampleAt = (it, n, key) => it.samples[it.instruments[n - 1].keyboard[key][1] - 1];

// ── the fixpoint ────────────────────────────────────────────────────────────

test("an export imported back by it2taud exports as the same bytes", async () => {
  const sources = {};
  for (const name of CONVERTER_SOURCES) sources[name] = await readFile(root + "vendor/converters/" + name);
  const py = await loadConverterRuntime({ loadPyodide, indexURL: root + "vendor/pyodide/", sources });

  // Two instruments with the record fields IT has words for.
  const a = {
    slot: 1, data: SINE, loop: [8, 64], sustain: true, dnv: 200,
    vol: envelope({ nodes: [[0, 0.04], [63, 0.2], [40, 0.4], [0, 0]], sus: [1, 2] }),
    pan: envelope({ nodes: [[0x40, 0.1], [0xc0, 0.1], [0x80, 0]], loop: [0, 0] }),
    bytes: { 171: 200, 172: 0x80, 174: 51, 175: 32, 180: 0xf8, 181: 64, 182: 100, 183: 20,
      186: 3 | (1 << 2), 187: 64, 188: 20, 195: 0x06, 178: 0x55, 179: 0x50 },
  };
  const b = {
    slot: 2, data: SAW, loop: [0, 48], pingpong: true, dnv: 128,
    vol: envelope({ nodes: [[63, 0.08], [20, 0.3], [10, 0.1], [0, 0]], carry: true }),
    pf: envelope({ nodes: [[0x80, 0.12], [0xff, 0.2], [0x60, 0]], filter: true }),
    bytes: { 186: 2, 172: 20 },
  };
  const D = 0x0d, E = 0x0e, F = 0x0f, G = 0x10, H = 0x11, S = 0x1c;
  const cells = {
    0: { note: C4, inst: 1, vol: [0, 40], pan: [0, 10] },
    1: { fx: D, arg: 0x0300 },
    2: { fx: E, arg: 0x0055 },
    3: { fx: F, arg: 0xf005 },
    4: { note: note(3), fx: G, arg: 0x00ab },
    5: { fx: H, arg: 0x4466 },
    6: { fx: 0x1e, arg: 0x2233 },                    // U
    7: { fx: 0x1b, arg: 0x1144 },                    // R
    8: { fx: 0x12, arg: 0x2211 },                    // I
    9: { fx: 0x13, arg: 0x0409 },                    // J
    10: { fx: 0x14, arg: 0x0200 },                   // K
    11: { note: note(5), fx: 0x15, arg: 0x2000 },    // L
    12: { fx: 0x16, arg: 0x3f00 },                   // M
    13: { fx: 0x17, arg: 0xf100 },                   // N
    14: { fx: 0x18, arg: 0x0400 },                   // O
    15: { fx: 0x19, arg: 0x0200 },                   // P
    16: { note: C4, fx: 0x1a, arg: 0x8300 },         // Q
    17: { fx: S, arg: 0x1100 },
    18: { fx: S, arg: 0x3200 },
    19: { fx: S, arg: 0x8077 },                      // S8x (nibble-repeated pan)
    20: { fx: S, arg: 0x8040 },                      // X
    21: { fx: S, arg: 0xc300 },
    22: { note: note(7), fx: S, arg: 0xd200 },
    23: { fx: 0x1f, arg: 0x8000 },                   // V
    24: { fx: 0x20, arg: 0x0300 },                   // W
    25: { fx: 0x22, arg: 0x3355 },                   // Y
    26: { vol: [1, 4] }, 27: { vol: [2, 7] }, 28: { vol: [3, 0x20 | 3] }, 29: { vol: [3, 5] },
    30: { note: 1 }, 31: { note: note(-5), inst: 2 }, 32: { note: 3 }, 33: { note: C4 }, 34: { note: 2 },
  };
  const doc = project({
    patterns: {
      0: cells,
      1: { 0: { note: note(-12), inst: 2, fx: 0x0a, arg: 0x0300 }, 8: { fx: 0x1d, arg: 0x7000 }, 16: { fx: S, arg: 0xb000 }, 20: { fx: S, arg: 0xb100 } },
    },
    cues: [{ lanes: [0, 1], inst: 0x0200 | 47 }, [1, 0]],
    instruments: [a, b], bpm: 140, tick: 5,
  });
  const first = exportItSong(doc, 0);
  assert.deepEqual(first.errors, []);
  const taud = runConverter(py, {
    script: "it2taud.py",
    argv: buildArgv({ isMidi: false, inPath: "/in.it", outPath: "/out.taud" }),
    inputs: [{ path: "/in.it", bytes: first.bytes }],
    output: "/out.taud",
    onLog: () => {},
  });
  const second = exportItSong(new Document(parseTaud(taud)), 0);
  assert.deepEqual(second.errors, []);
  assert.equal(second.bytes.length, first.bytes.length);
  const at = second.bytes.findIndex((v, i) => v !== first.bytes[i]);
  assert.equal(at, -1, `first difference at byte ${at}`);
});

// ── pitch ───────────────────────────────────────────────────────────────────

test("a microtone is a detuned sample, and a key played at two is a second instrument", () => {
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1 }, 1: { note: cents(25) }, 2: { note: cents(250) }, 3: { note: C4 } } },
    cues: [[0]], instruments: [inst1],
  });
  const r = exportItSong(doc, 0);
  assert.deepEqual(codes(r.warnings), ["variants"]);
  const it = readIt(r.bytes);
  assert.equal(it.instruments.length, 2, "C4 and C4 + 25 c share a key");
  const cell = (row) => it.patterns[0][row][0];
  assert.deepEqual([cell(0).note, cell(0).inst], [60, 1]);
  assert.deepEqual([cell(1).note, cell(1).inst], [60, 2]);
  // C4 + 250 c is D4 + 50 c, back on instrument 1 (D is played at one pitch
  // only), with the volume the bare note kept spelt out.
  assert.deepEqual([cell(2).note, cell(2).inst, cell(2).vc], [62, 1, 64]);
  assert.deepEqual([cell(3).note, cell(3).inst], [60, 0], "the plain C: the channel holds instrument 1 already");
  assert.equal(sampleAt(it, 1, 60).c5, 8363);
  assert.equal(sampleAt(it, 2, 60).c5, Math.round(8363 * 2 ** ((cents(25) - C4) / 4096)));
  assert.equal(sampleAt(it, 1, 62).c5, Math.round(8363 * 2 ** ((cents(250) - (C4 + 2 * SEMI)) / 4096)));
  assert.equal(sampleAt(it, 2, 60).name, " +25c");
  // The copies share one set of sample data.
  assert.equal(new Set(it.samples.map((s) => s.ptr)).size, 1);
});

test("a 12-tone song writes no microtones, and an off-standard tuning detunes every sample", () => {
  const tune = { 0: { note: note(0), inst: 1 }, 1: { note: note(4) }, 2: { note: note(7) }, 3: { note: note(-13) } };
  for (const t of [[0xa000, 8363], [0x5c00, 440], [0x5000, 262], [0, 0]]) {
    const r = exportItSong(project({ patterns: { 0: tune }, cues: [[0]], instruments: [inst1], tuning: t }), 0);
    assert.deepEqual(r.warnings, [], `tuning ${t}`);
    const it = readIt(r.bytes);
    assert.equal(it.samples.length, 1);
    assert.equal(it.samples[0].c5, 8363);
    assert.deepEqual([0, 1, 2, 3].map((row) => it.patterns[0][row][0].note), [60, 64, 67, 47]);
  }
  const r = exportItSong(project({ patterns: { 0: tune }, cues: [[0]], instruments: [inst1], tuning: [0x5c00, 432] }), 0);
  assert.deepEqual(codes(r.warnings), ["tuning"]);
  assert.equal(readIt(r.bytes).samples[0].c5, Math.round(8363 * tuningRatioOf(0x5c00, 432)));
});

// ── instruments ─────────────────────────────────────────────────────────────

test("volume layers become one instrument each, chosen by the note's volume", () => {
  const quiet = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
  const loud = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  const ixmp = {
    1: [
      { data: quiet, pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 31, samplingRate: 8000 },
      { data: loud, pitchStart: 0, pitchEnd: 0xffff, volumeStart: 32, volumeEnd: 63, samplingRate: 16000 },
    ],
  };
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1, vol: [0, 10] }, 4: { note: C4, inst: 1, vol: [0, 50] }, 8: { note: C4, inst: 1 } } },
    cues: [[0]], instruments: [{ ...inst1, dnv: 0xff }], ixmp,
  });
  const r = exportItSong(doc, 0);
  assert.deepEqual(codes(r.warnings), ["velocitySplit"]);
  const it = readIt(r.bytes);
  assert.equal(it.instruments.length, 2);
  const [q, l] = [0, 4].map((row) => it.patterns[0][row][0].inst);
  assert.equal(sampleAt(it, q, 60).c5, 8000);
  assert.equal(sampleAt(it, l, 60).c5, 16000);
  assert.equal(it.patterns[0][8][0].inst, l, "the default volume (full) plays the loud layer");
  assert.match(it.instruments[q - 1].name, / 0-31$/);
});

test("the record's fields are IT's, envelopes timed at the song's tempo", () => {
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1 } } }, cues: [[0]], bpm: 125,
    instruments: [{
      ...inst1, dnv: 128,
      vol: envelope({ nodes: [[0, 0.1], [63, 0.5], [0, 0]], sus: [1, 1] }),
      pf: envelope({ nodes: [[0x80, 0.2], [0xff, 0]] }),
      bytes: { 171: 128, 172: 0x00, 173: 0x02, 186: 0, 195: 0x07, 180: 40, 182: 0xff },
    }],
  });
  const it = readIt(exportItSong(doc, 0).bytes);
  const ins = it.instruments[0];
  assert.equal(ins.nna, 2, "key-off");
  assert.equal(ins.fadeout, 512);
  assert.equal(ins.gbv, 64);
  assert.equal(ins.pps, 32, "clamped to IT's ±32");
  assert.deepEqual([ins.dct, ins.dca], [3, 1]);
  assert.equal(ins.ifc & 0x80, 0, "filter off");
  // 125 BPM is 50 ticks a second.
  assert.deepEqual(ins.env[0], { flags: 5, num: 3, lpb: 0, lpe: 0, slb: 1, sle: 1, nodes: [[0, 0], [64, 5], [0, 30]] });
  assert.deepEqual(ins.env[2].nodes, [[0, 0], [32, 10]], "a pitch envelope, ±16 semitones");
  assert.equal(ins.env[2].flags & 0x80, 0);
  assert.equal(it.samples[0].vol, 32, "default note volume");
  assert.equal(it.samples[0].flags & 0x10, 0x10, "forward loop");
});

test("a SoundFont filter becomes IT's by the frequency it means", () => {
  // 7000 cents above 8.176 Hz is ~470 Hz: IT cutoff 24 × (log2(470/110) − ¼) = 44.
  const sf = { ...inst1, bytes: { 173: 0x10, 182: 7000 >> 8, 252: 7000 & 0xff, 183: 0, 253: 60 } };
  const r = exportItSong(project({ patterns: { 0: { 0: { note: C4, inst: 1 } } }, cues: [[0]], instruments: [sf] }), 0);
  assert.deepEqual(codes(r.warnings), ["soundfont"]);
  const ins = readIt(r.bytes).instruments[0];
  assert.equal(ins.ifc, 0x80 | 44);
  assert.equal(ins.ifr, 0x80 | 32, "6 dB of resonance");
});

test("an OPL instrument is rendered into a looped sample that fades on release", () => {
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1 }, 16: { note: note(4) }, 32: { note: note(16) } } },
    cues: [[0]], tuning: [0x5c00, 440],
  });
  doc.undo = new UndoStack(doc);
  const plan = planCreateOpl(doc, defaultOplRecord(), "Organ");
  doc.undo.apply(importBankOp(plan));
  const r = exportItSong(doc, 0);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.find((w) => w.code === "rendered").args, { names: "Organ" });
  const it = readIt(r.bytes);
  assert.equal(it.samples.length, 2, "one bounce per octave played");
  for (const s of it.samples) {
    assert.equal(s.flags & 0x02, 0x02, "16-bit");
    assert.ok(s.flags & 0x10 && s.loopEnd > s.loopBeg, "the default patch sustains: looped");
    assert.ok(s.length > 10000, `a held note, not a click (${s.length} frames)`);
  }
  assert.equal(it.instruments[0].fadeout, 64);
  assert.notEqual(sampleAt(it, 1, 60).ptr, sampleAt(it, 1, 76).ptr, "the high note has its own bounce");
});

test("SoundFont layered instruments are rendered at a note and volume the song plays", () => {
  // Both demos' presets are layered metainstruments whose layers keep only the
  // zones the song plays (trimmed key maps, a silent base record): a bounce of
  // anything else — or with the project's key maps left out — is silence, which
  // came out as a one-frame sample. 16uba's Tine Electric Piano answers only at
  // volumes up to 52, so a bounce at full volume found nothing either.
  for (const name of ["Huygens_clock", "16uba_baion"]) {
    const doc = new Document(parseTaud(readFileSync(root + `assets/demo_projects/${name}.taud`)));
    const r = exportItSong(doc, 0);
    assert.deepEqual(r.errors, [], name);
    assert.ok(!r.warnings.some((w) => w.code === "silent"), `${name}: ${JSON.stringify(r.warnings.find((w) => w.code === "silent"))}`);
    const bounced = readIt(r.bytes).samples.filter((x) => x.flags & 0x02);
    assert.ok(bounced.length > 0, name);
    for (const x of bounced) assert.ok(x.length > 1000, `${name}: “${x.name}” is ${x.length} frames`);
  }
});

// ── the patterns ────────────────────────────────────────────────────────────

test("effects and columns: IT's words, recalls resolved, the overflow carried over", () => {
  const doc = project({
    patterns: {
      0: {
        0: { note: C4, inst: 1, fx: 0x0d, arg: 0x0300 },     // D $0300 → D03
        1: { fx: 0x0d, arg: 0 },                            // Taud's own D memory → D03
        2: { fx: 0x14, arg: 0 },                            // K with nothing to recall → H00
        3: { fx: 0x0e, arg: 0xf010 },                       // fine 16 units → EF3? no: EE3
        4: { fx: 0x0f, arg: 0xf015 },                       // fine 21 units = 1/16 semitone → FF1
        5: { fx: 0x1d, arg: 0x0013 },                       // tempo slide up 3 → T13
        6: { fx: 0x1f, arg: 0xff00 },                       // V $FF → V80
        7: { vol: [1, 12] },                                // slide up 12: past the column's 9 → D C0
        8: { vol: [1, 12], fx: 0x0a, arg: 0x0400 },         // …unless the effect is taken → C9
        9: { pan: [0, 63] },                                // pan SET → volume-column pan 64
        10: { vol: [0, 30], pan: [0, 0] },                  // both: the pan becomes X00
        11: { vol: [0, 30], pan: [0, 20], fx: 0x0a, arg: 0x0300 }, // all three: the pan is dropped
        12: { fx: 0x1c, arg: 0x2300 },                      // S $23 (finetune): no IT word
        13: { note: 4 },                                    // fast fade → note cut
        14: { note: 3 },                                    // note fade
      },
    },
    cues: [[0]], instruments: [inst1],
  });
  const r = exportItSong(doc, 0);
  const at = (row) => { const c = readIt(r.bytes).patterns[0][row][0]; return [c.fx ? String.fromCharCode(64 + c.fx) : "-", c.arg, c.vc]; };
  assert.deepEqual(at(0), ["D", 0x03, -1]);
  assert.deepEqual(at(1), ["D", 0x03, -1]);
  assert.deepEqual(at(2), ["H", 0x00, -1]);
  assert.deepEqual(at(3), ["E", 0xe3, -1]);
  assert.deepEqual(at(4), ["F", 0xf1, -1]);
  assert.deepEqual(at(5), ["T", 0x13, -1]);
  assert.deepEqual(at(6), ["V", 0x80, -1]);
  assert.deepEqual(at(7), ["D", 0xc0, -1]);
  assert.deepEqual(at(8), ["A", 0x04, 94]);
  assert.deepEqual(at(9), ["-", 0, 128 + 64]);
  assert.deepEqual(at(10), ["X", 0, 30]);
  assert.deepEqual(at(11), ["A", 3, 30]);
  assert.equal(readIt(r.bytes).patterns[0][13][0].note, 254);
  assert.equal(readIt(r.bytes).patterns[0][14][0].note, 246);
  const w = Object.fromEntries(r.warnings.map((f) => [f.code, f]));
  assert.deepEqual(w.effect.args, { fx: "S $2x" });
  assert.deepEqual(w.effect.where, { cue: 0, lane: 0, row: 12 });
  assert.equal(w.dropped.args.n, 1);
  assert.equal(w.rounded.args.n, 1, "the clamped slide");
  assert.equal(w.fastFade.args.n, 1);
});

// The round trip's second set: what it2taud reads differently from what the
// export meant unless the export says it the importer's way.

test("a sample offset is the nearest $100, and never O00 for a real one", () => {
  const O = 0x18;
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1, fx: O, arg: 0x0080 }, 1: { note: C4, fx: O, arg: 0x0180 },
      2: { note: C4, fx: O, arg: 0 }, 3: { note: C4, fx: O, arg: 0x0400 } } },
    cues: [[0]], instruments: [inst1],
  });
  const r = exportItSong(doc, 0);
  const it = readIt(r.bytes);
  assert.deepEqual([0, 1, 2, 3].map((row) => it.patterns[0][row][0].arg), [1, 2, 0, 4],
    "O00 would recall the last offset in IT");
  assert.equal(r.warnings.find((f) => f.code === "rounded").args.n, 2);
});

test("a channel past the song's last used one keeps the default pan", () => {
  // Lanes 0 and 2 play; lane 1 is a gap and lane 3 only restates its pan, as
  // a subsong of a project whose other songs use lane 3 would.
  const doc = project({
    patterns: {
      0: { 0: { note: C4, inst: 1, pan: [0, 10] } },
      1: { 0: { pan: [0, 50] } },
      2: { 0: { note: C4, inst: 1, pan: [0, 40] } },
      3: { 0: { pan: [0, 60] } },
    },
    cues: [[0, 1, 2, 3]], instruments: [inst1],
  });
  const pans = readIt(exportItSong(doc, 0).bytes).chnPan.slice(0, 4);
  assert.equal(pans[3], 32, "it2taud drops a channel at the end, and its pan with it");
  assert.notEqual(pans[1], 32, "a gap is a lane to it2taud, pan and all");
  assert.notEqual(pans[2], 32);
});

test("an instrument with no sample on any key leaves its pan unused", () => {
  const panned = { bytes: { 17: 0x80, 177: 0x40 } };          // the `p` bit, pan 64
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1 }, 1: { note: C4, inst: 2 } } },
    cues: [[0]],
    instruments: [{ ...inst1, ...panned }, { slot: 2, data: new Uint8Array(0), ...panned }],
  });
  const it = readIt(exportItSong(doc, 0).bytes);
  assert.equal(it.instruments[0].dfp, 16);
  assert.ok(it.instruments[1].keyboard.every(([, s]) => s === 0));
  assert.equal(it.instruments[1].dfp, 0x80 | 32, "it2taud makes no record of it, so no pan");
});

test("the cue sheet: a cue's rows are its pattern's, a jump a B in a free channel, a halt the end", () => {
  const PATLEN = (n) => 0x0200 | (n - 1);
  const JUMP = (n) => 0xf000 | n;
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1, pan: [0, 10] } }, 1: { 0: { note: note(2), inst: 1, pan: [0, 10] } } },
    cues: [{ lanes: [0], inst: PATLEN(16) }, { lanes: [1], inst: JUMP(0) }, { lanes: [0], inst: 0x0100 }, [1]],
    instruments: [inst1], bpm: 150, tick: 3,
  });
  const r = exportItSong(doc, 0);
  assert.deepEqual(r.errors, []);
  const it = readIt(r.bytes);
  assert.deepEqual([it.speed, it.tempo], [3, 150]);
  assert.deepEqual(it.orders, [0, 1, 2, 255], "three orders, then the end");
  assert.equal(it.patterns[0].length, 16);
  assert.equal(it.patterns[2].length, 64, "cue 2 plays the same lane pattern for longer: its own pattern");
  const jump = it.patterns[1][63][0];
  assert.deepEqual([jump.fx, jump.arg], [L("B"), 0]);
  // The lane's opening pan is the channel's: the header carries it, not the rows.
  assert.equal(it.chnPan[0], 10);
  assert.equal(it.patterns[0][0][0].vc, -1);
});

// ── prerequisites and files ─────────────────────────────────────────────────

test("only a surround project or a linear-frequency song stops the export", () => {
  const busy = { 0: { note: C4, inst: 1 } };
  const freq = project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1], flags: 2 });
  assert.deepEqual(codes(exportItSong(freq, 0).errors), ["toneMode"]);
  assert.equal(exportItSong(freq, 0).bytes, null, "nothing is written");
  const wide = project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1] });
  wide.wideCells = true;
  assert.deepEqual(codes(exportItSong(wide, 0).errors), ["format"]);
  for (const flags of [0, 1]) {
    const ok = exportItSong(project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1], flags }), 0);
    assert.deepEqual(ok.errors, []);
    assert.equal(readIt(ok.bytes).flags & 0x08, flags === 0 ? 0x08 : 0, "linear slides");
  }
  // Five lanes, 300 BPM: a module has 64 channels, and the tempo plays at 255.
  const big = project({ patterns: { 0: busy }, cues: [[0, 0, 0, 0, 0]], instruments: [inst1], bpm: 300 });
  const r = exportItSong(big, 0);
  assert.deepEqual(codes(r.warnings), ["tempo"]);
  assert.equal(readIt(r.bytes).tempo, 255);
});

test("every song is its own module, and the project's message is the song's", () => {
  const doc = project({ patterns: { 0: { 0: { note: C4, inst: 1 } } }, cues: [[0]], instruments: [inst1], name: "Two songs" });
  doc.songs.push(doc.songs[0]);
  doc.setSection("PMsg", new TextEncoder().encode("line one\nline two"));
  const all = exportItSongs(doc);
  assert.equal(all.length, 2);
  assert.ok(all.every((r) => r.bytes !== null));
  const it = readIt(all[0].bytes);
  assert.equal(it.title, "Two songs");
  assert.equal(it.message, "line one\rline two");
  assert.equal(it.special & 1, 1);
  assert.equal(itFileName("song", 1, 2), "song-2.it");
  assert.equal(itFileName("song", 0, 1), "song.it");
});
