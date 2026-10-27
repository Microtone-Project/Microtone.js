// ProTracker export (item 219) — src/convert/modexport.js, the inverse of
// mod2taud.py. The strong test is the round trip: a module mod2taud imports
// (under the vendored Pyodide, as convert.test.js runs it) exports as the SAME
// BYTES. The rest build small projects by hand and check one rule each: the
// prerequisites that stop an export, the pitch mapping of a song written in
// Microtone, the cue sheet written into the patterns, the bounce of an OPL
// instrument.
//
// "alternate past" (the 31-TET piece the item names) is local-only, like the
// golden gate's corpus: its leg skips when the files are absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadPyodide } from "../../vendor/pyodide/pyodide.js";
import {
  CONVERTER_SOURCES, loadConverterRuntime, runConverter, buildArgv,
} from "../../src/convert/convert-core.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { SAMPLEINST_SIZE, SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { PT_PERIODS } from "../../core/tuning/pitchtables.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { importBankOp } from "../../src/doc/ops.js";
import { planCreateOpl } from "../../src/doc/bankmerge.js";
import { defaultOplRecord } from "../../src/doc/opledit.js";
import { exportModSong, exportModSongs, modFileName } from "../../src/convert/modexport.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// ── a module, byte for byte as the exporter writes one ──────────────────────

const CH = 4;

/** cells: { "row:ch": [period, sample, effect, arg] } per pattern. */
function makeMod({ title, samples, orders, patterns }) {
  const sampleBytes = samples.reduce((n, s) => n + (s?.data.length ?? 0), 0);
  const buf = new Uint8Array(1084 + patterns.length * 1024 + sampleBytes);
  const dv = new DataView(buf.buffer);
  const put = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  put(0, title);
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    const s = samples[i];
    if (!s) { dv.setUint16(o + 28, 1); continue; }
    put(o, s.name);
    dv.setUint16(o + 22, s.data.length / 2);
    buf[o + 24] = s.finetune & 15;
    buf[o + 25] = s.volume;
    dv.setUint16(o + 26, s.loop ? s.loop[0] / 2 : 0);
    dv.setUint16(o + 28, s.loop ? s.loop[1] / 2 : 1);
  }
  buf[950] = orders.length;
  buf[951] = 0x7f;
  orders.forEach((p, i) => { buf[952 + i] = p; });
  put(1080, "M.K.");
  patterns.forEach((cells, p) => {
    for (const [key, [period, smp, fx, arg]] of Object.entries(cells)) {
      const [row, ch] = key.split(":").map(Number);
      const o = 1084 + p * 1024 + (row * CH + ch) * 4;
      buf[o] = (smp & 0xf0) | (period >> 8);
      buf[o + 1] = period & 0xff;
      buf[o + 2] = ((smp & 15) << 4) | fx;
      buf[o + 3] = arg;
    }
  });
  let o = 1084 + patterns.length * 1024;
  for (const s of samples) {
    if (!s) continue;
    buf.set(Uint8Array.from(s.data, (v) => v & 0xff), o);
    o += s.data.length;
  }
  return buf;
}

const ramp = (n, step) => Array.from({ length: n }, (_, i) => ((i * step) % 200) - 100);

test("an imported module exports as the same bytes", async () => {
  const sources = {};
  for (const name of CONVERTER_SOURCES) sources[name] = await readFile(root + "vendor/converters/" + name);
  const py = await loadConverterRuntime({ loadPyodide, indexURL: root + "vendor/pyodide/", sources });

  // Every ProTracker effect the importer carries across without changing it,
  // on all four channels, the patterns in first-use order (the importer
  // renumbers them that way, so any other order could not come back).
  const P = PT_PERIODS;
  const mod = makeMod({
    title: "roundtrip",
    samples: [
      { name: "looped", finetune: 3, volume: 40, data: ramp(64, 7), loop: [16, 32] },
      { name: "one-shot", finetune: -2, volume: 64, data: ramp(32, 13) },
    ],
    orders: [0, 1, 0],
    patterns: [
      {
        "0:0": [P[24], 1, 0xf, 0x04], "0:1": [P[28], 2, 0xf, 0x78], "0:2": [P[31], 1, 0x0, 0x37],
        "0:3": [P[12], 2, 0xc, 0x20],
        "1:0": [0, 0, 0x1, 0x05], "2:0": [0, 0, 0x2, 0x03], "3:0": [P[26], 0, 0x3, 0x08],
        "4:0": [0, 0, 0x5, 0x03], "5:0": [0, 0, 0x5, 0x30],
        "1:1": [0, 0, 0x4, 0x46], "2:1": [0, 0, 0x6, 0x02], "3:1": [0, 0, 0x7, 0x34],
        "4:1": [P[30], 1, 0x9, 0x10], "5:1": [0, 0, 0xa, 0x04], "6:1": [0, 0, 0xa, 0x30],
        "1:2": [0, 0, 0xe, 0x13], "2:2": [0, 0, 0xe, 0x22], "3:2": [0, 0, 0xe, 0xa2],
        "4:2": [0, 0, 0xe, 0xb3], "5:2": [P[33], 2, 0xe, 0xd2], "6:2": [0, 0, 0xe, 0xc3],
        "1:3": [0, 0, 0xe, 0x31], "2:3": [0, 0, 0xe, 0x42], "3:3": [0, 0, 0xe, 0x71],
        "4:3": [0, 0, 0xe, 0x53], "5:3": [0, 0, 0xe, 0x93], "6:3": [0, 0, 0xe, 0xf5],
        "7:3": [P[47], 1, 0xc, 0x40], "8:3": [P[12], 1, 0xc, 0x00],
        "62:0": [0, 0, 0xe, 0xe1], "63:1": [0, 0, 0xd, 0x16],
      },
      {
        "0:0": [P[20], 1, 0, 0], "0:1": [P[21], 2, 0, 0], "0:2": [P[22], 1, 0, 0], "0:3": [P[23], 2, 0, 0],
        "8:0": [0, 0, 0xe, 0x60], "16:0": [0, 0, 0xe, 0x62],
      },
    ],
  });
  const taud = runConverter(py, {
    script: "mod2taud.py",
    argv: buildArgv({ isMidi: false, inPath: "/in.mod", outPath: "/out.taud" }),
    inputs: [{ path: "/in.mod", bytes: mod }],
    output: "/out.taud",
    onLog: () => {},
  });
  const r = exportModSong(new Document(parseTaud(taud)), 0);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.bytes.length, mod.length);
  const first = r.bytes.findIndex((b, i) => b !== mod[i]);
  assert.equal(first, -1, `first difference at byte ${first}`);
});

test("alternate past (31-TET) comes back as the same music", { skip: !existsSync(root + "../alternate past.mod") }, () => {
  const mod = readFileSync(root + "../alternate past.mod");
  const r = exportModSong(new Document(parseTaud(readFileSync(root + "../alternate past.taud"))), 0);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.map((w) => w.code), ["microtonal"]);
  const out = Buffer.from(r.bytes);
  // Everything but the pattern NUMBERS, which the importer renumbers by first use.
  assert.deepEqual(out.subarray(0, 952), mod.subarray(0, 952), "title, samples, song length");
  const len = mod[950];
  for (let o = 0; o < len; o++) {
    const a = 1084 + mod[952 + o] * 1024, b = 1084 + out[952 + o] * 1024;
    assert.deepEqual(out.subarray(b, b + 1024), mod.subarray(a, a + 1024), `order ${o}`);
  }
  const tail = (f) => f.subarray(1084 + (Math.max(...f.subarray(952, 952 + 128)) + 1) * 1024);
  assert.deepEqual(tail(out), tail(mod), "sample data");
});

// ── projects built by hand ──────────────────────────────────────────────────

const EMPTY_CUE = 0x7fff;

/**
 * A Document with `patterns` (index → {row: cell}) and `cues` (each a list of
 * pattern indices, lane by lane; `inst` an instruction word). A cell is
 * {note, inst, vol: [sel, value], pan: [sel, value], fx, arg}.
 */
function project({ patterns = {}, cues = [], flags = 1, bpm = 125, tick = 6,
  tuning = [0xa000, 8363], instruments = [], fmt = 2 } = {}) {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  let ptr = 0;
  for (const s of instruments) {
    const dv = new DataView(image.buffer, SAMPLEBIN_SIZE + s.slot * 256, 256);
    const rec = new Uint8Array(image.buffer, SAMPLEBIN_SIZE + s.slot * 256, 256);
    image.set(s.data, ptr);
    dv.setUint32(0, ptr, true);
    dv.setUint16(4, s.data.length, true);
    dv.setUint16(6, s.rate ?? 8363, true);
    dv.setUint16(10, s.loop?.[0] ?? 0, true);
    dv.setUint16(12, s.loop?.[1] ?? 0, true);
    rec[14] = s.loop ? (s.pingpong ? 2 : 1) : 0;
    dv.setUint16(15, 0x2020, true);
    rec[21] = 63;
    rec[171] = 0xff;
    rec[182] = 0xff;
    rec[183] = 0xff;
    rec[196] = s.dnv ?? 0xff;
    ptr += s.data.length;
  }
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
    projSections: [], ixmp: [],
    meta: { projectName: "hand-built", songMeta: {} },
  });
}

const C4 = 0x5000;
const SEMI = 4096 / 12;
const note = (semis) => Math.round(C4 + semis * SEMI);
const SINE = Uint8Array.from({ length: 64 }, (_, i) => 128 + Math.round(100 * Math.sin((2 * Math.PI * i) / 64)));
const inst1 = { slot: 1, data: SINE, loop: [0, 64] };

/** One exported cell: {period, sample, fx, arg}. */
function cellOf(bytes, order, row, ch) {
  const p = bytes[952 + order];
  const o = 1084 + p * 1024 + (row * CH + ch) * 4;
  return {
    period: ((bytes[o] & 15) << 8) | bytes[o + 1],
    sample: (bytes[o] & 0xf0) | (bytes[o + 2] >> 4),
    fx: bytes[o + 2] & 15,
    arg: bytes[o + 3],
  };
}

const codes = (list) => list.map((f) => f.code).sort();

test("the prerequisites stop an export, and say where", () => {
  const busy = { 0: { note: C4, inst: 1 } };
  const five = project({ patterns: { 0: busy }, cues: [[0, 0, 0, 0, 0]], instruments: [inst1] });
  assert.deepEqual(codes(exportModSong(five, 0).errors), ["lanes"]);

  const linear = project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1], flags: 0 });
  assert.deepEqual(codes(exportModSong(linear, 0).errors), ["toneMode"]);

  const fast = project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1], bpm: 300, tick: 40 });
  assert.deepEqual(codes(exportModSong(fast, 0).errors), ["speed", "tempo"]);

  const detuned = project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1], tuning: [0x5c00, 432] });
  assert.deepEqual(codes(exportModSong(detuned, 0).errors), ["tuning"]);
  for (const t of [[0x5c00, 440], [0x5000, 262], [0, 0]]) {
    const ok = project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1], tuning: t });
    assert.deepEqual(exportModSong(ok, 0).errors, [], `tuning ${t}`);
  }

  // M (lane volume) has no ProTracker word; the first place it is used is named.
  const m = project({
    patterns: { 0: { ...busy, 5: { fx: 0x16, arg: 0x2000 }, 9: { fx: 0x16, arg: 0x1000 } } },
    cues: [[null, 0]], instruments: [inst1],
  });
  const [err] = exportModSong(m, 0).errors;
  assert.equal(err.code, "effect");
  assert.deepEqual(err.args, { fx: "M" });
  assert.equal(err.count, 2);
  assert.deepEqual(err.where, { cue: 0, lane: 1, row: 5 });
  assert.equal(exportModSong(m, 0).bytes, null, "nothing is written");

  const wide = project({ patterns: { 0: busy }, cues: [[0]], instruments: [inst1] });
  wide.wideCells = true;
  assert.ok(codes(exportModSong(wide, 0).errors).includes("format"));
});

test("a 12-tone song takes ProTracker's own periods, a microtonal one raw periods", () => {
  const tune = { 0: { note: note(0), inst: 1 }, 1: { note: note(4) }, 2: { note: note(7) }, 3: { note: note(-12) } };
  const r = exportModSong(project({ patterns: { 0: tune }, cues: [[0]], instruments: [inst1], tuning: [0x5c00, 440] }), 0);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([0, 1, 2, 3].map((row) => cellOf(r.bytes, 0, row, 0).period), [428, 339, 285, 856]);
  assert.equal(cellOf(r.bytes, 0, 0, 0).sample, 1);

  const quarter = { 0: { note: note(0), inst: 1 }, 1: { note: note(0.5) } };
  const q = exportModSong(project({ patterns: { 0: quarter }, cues: [[0]], instruments: [inst1] }), 0);
  assert.deepEqual(codes(q.warnings), ["microtonal"]);
  assert.equal(cellOf(q.bytes, 0, 0, 0).period, 428);
  assert.equal(cellOf(q.bytes, 0, 1, 0).period, Math.round(428 * 2 ** (-0.5 / 12)));
});

test("ProTracker Temperament notes come out as the table's own periods", () => {
  const ptNote = (period) => Math.round(C4 + 4096 * Math.log2(428 / period));
  // The table's extension octaves stray 35-71 units from 12-TET: that must not make the song microtonal.
  const periods = [856, 428, 285, 113, 75];
  const cells = {};
  periods.forEach((p, i) => { cells[i] = { note: ptNote(p), ...(i === 0 ? { inst: 1 } : {}) }; });
  const r = exportModSong(project({ patterns: { 0: cells }, cues: [[0]], instruments: [inst1] }), 0);
  assert.deepEqual(codes(r.warnings), ["range"], "no microtonal warning");
  assert.deepEqual(periods.map((_, i) => cellOf(r.bytes, 0, i, 0).period), periods);
});

test("a sample recorded high is resampled into ProTracker's range, its finetune kept", () => {
  // A 44.1 kHz sample played at C4 would need a period of 81 — past ProTracker's
  // B-3 (113). Down an octave it sounds as F-3 with a finetune of -2.
  const hifi = { slot: 1, data: Uint8Array.from({ length: 2000 }, (_, i) => 128 + ((i * 37) % 100) - 50), rate: 44100, loop: [400, 2000] };
  const r = exportModSong(project({ patterns: { 0: { 0: { note: C4, inst: 1 } } }, cues: [[0]], instruments: [hifi] }), 0);
  assert.deepEqual(codes(r.warnings), ["resampled"]);
  const dv = new DataView(r.bytes.buffer);
  assert.equal(dv.getUint16(42) * 2, 1000, "half the frames");
  assert.equal(dv.getUint16(46) * 2, 200, "loop start follows");
  assert.equal(dv.getUint16(48) * 2, 800, "loop length follows");
  assert.equal(r.bytes[44], 14, "finetune -2");
  assert.equal(cellOf(r.bytes, 0, 0, 0).period, 160, "F-3");
});

test("a ping-pong loop is unrolled into a forward one", () => {
  const pp = { slot: 1, data: Uint8Array.from({ length: 40 }, (_, i) => 128 + i), loop: [10, 30], pingpong: true };
  const r = exportModSong(project({ patterns: { 0: { 0: { note: C4, inst: 1 } } }, cues: [[0]], instruments: [pp] }), 0);
  const dv = new DataView(r.bytes.buffer);
  const len = dv.getUint16(42) * 2;
  assert.equal(len, 30 + 18, "the loop and its way back; what lay past it goes");
  assert.equal(dv.getUint16(46) * 2, 10);
  assert.equal(dv.getUint16(48) * 2, 38);
  const data = new Int8Array(r.bytes.buffer, r.bytes.length - len, len);
  assert.deepEqual([...data.subarray(28, 32)], [28, 29, 28, 27], "turns at the loop end");
});

test("the cue sheet and the song's starting speed are written into the patterns", () => {
  const PATLEN = (n) => 0x0200 | (n - 1);
  const JUMP = (n) => 0xf000 | n;
  const HALT = 0x0100;
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1 } }, 1: { 0: { note: note(2), inst: 1 } } },
    cues: [{ lanes: [0], inst: PATLEN(32) }, { lanes: [1], inst: JUMP(0) }, { lanes: [0], inst: HALT }, [1]],
    instruments: [inst1], bpm: 150, tick: 3,
  });
  const r = exportModSong(doc, 0);
  assert.deepEqual(r.errors, []);
  assert.equal(r.bytes[950], 3, "the song ends at the halt");
  // Into the first free effect slots of row 0 — the note's own is free.
  assert.deepEqual(cellOf(r.bytes, 0, 0, 0), { period: 428, sample: 1, fx: 0xf, arg: 3 }, "speed 3");
  assert.deepEqual(cellOf(r.bytes, 0, 0, 1), { period: 0, sample: 0, fx: 0xf, arg: 150 }, "150 BPM");
  assert.deepEqual(cellOf(r.bytes, 0, 31, 0), { period: 0, sample: 0, fx: 0xd, arg: 0 }, "the cue's 32 rows");
  assert.deepEqual(cellOf(r.bytes, 1, 63, 0), { period: 0, sample: 0, fx: 0xb, arg: 0 }, "the jump");
  // Order 0 carries the speed and the break, order 2 plays the same lane
  // pattern without them: two patterns, not one.
  assert.notEqual(r.bytes[952], r.bytes[954]);
});

test("columns: a slide rides a portamento, a clash keeps the effect, a cut restores the sample", () => {
  const doc = project({
    patterns: {
      0: {
        0: { note: C4, inst: 1, fx: 0x10, arg: 0x00ab },               // G $00AB → 3 08
        1: { note: note(5), fx: 0x10, arg: 0, vol: [2, 3] },            // G recall + slide down → 5 03
        2: { fx: 0x11, arg: 0x4466, vol: [0, 20] },                     // H + volume SET: H stays
        3: { note: 2 },                                                 // cut → C00
        4: { note: note(7) },                                           // bare note after a cut: sample 1 again
        5: { fx: 0x0f, arg: 0x0003 },                                   // F $0003 → 1 03
        6: { fx: 0x0e, arg: 0 },                                        // E recall of F's 3 → 2 03
        7: { fx: 0x13, arg: 0x0409 },                                   // J → 0 37
        8: { fx: 0x13, arg: 0 },                                        // J recall → 0 37
      },
    },
    cues: [[0]], instruments: [inst1],
  });
  const r = exportModSong(doc, 0);
  assert.deepEqual(r.errors, []);
  const at = (row) => cellOf(r.bytes, 0, row, 0);
  assert.deepEqual([at(0).fx, at(0).arg], [3, 8]);
  assert.deepEqual([at(1).fx, at(1).arg], [5, 3]);
  assert.deepEqual([at(2).fx, at(2).arg], [4, 0x46]);
  assert.deepEqual([at(3).fx, at(3).arg], [0xc, 0]);
  assert.equal(at(4).sample, 1);
  assert.deepEqual([at(5).fx, at(5).arg], [1, 3]);
  assert.deepEqual([at(6).fx, at(6).arg], [2, 3]);
  assert.deepEqual([at(7).fx, at(7).arg], [0, 0x37]);
  assert.deepEqual([at(8).fx, at(8).arg], [0, 0x37]);
  assert.deepEqual(r.warnings.find((w) => w.code === "dropped").args, { n: 1 });
});

test("an OPL instrument is bounced into a looped sample at the engine's level", () => {
  const doc = project({
    patterns: { 0: { 0: { note: C4, inst: 1 }, 16: { note: note(4) } } },
    cues: [[0]], tuning: [0x5c00, 440],
  });
  doc.undo = new UndoStack(doc);
  const plan = planCreateOpl(doc, defaultOplRecord(), "Organ");
  doc.undo.apply(importBankOp(plan));
  assert.equal(plan.metaSlot, 1);
  const r = exportModSong(doc, 0);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.find((w) => w.code === "bounced").args, { names: "Organ" });
  const dv = new DataView(r.bytes.buffer);
  const len = dv.getUint16(42) * 2;
  const loopLen = dv.getUint16(48) * 2;
  assert.ok(len > 10000, `a held note, not a click (${len} bytes)`);
  assert.ok(loopLen > 2 && dv.getUint16(46) * 2 + loopLen <= len, "the default patch sustains: looped");
  const data = new Int8Array(r.bytes.buffer, r.bytes.length - len, len);
  const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak > 40, `audible (${peak})`);
  // Both notes are on the 12-tone grid, so they are table periods.
  assert.ok(PT_PERIODS.includes(cellOf(r.bytes, 0, 0, 0).period));
});

test("every song is its own module", () => {
  const doc = project({ patterns: { 0: { 0: { note: C4, inst: 1 } } }, cues: [[0]], instruments: [inst1] });
  doc.songs.push(doc.songs[0]);
  const all = exportModSongs(doc);
  assert.equal(all.length, 2);
  assert.ok(all.every((r) => r.bytes !== null));
  assert.equal(modFileName("song", 1, 2), "song-2.mod");
  assert.equal(modFileName("song", 0, 1), "song.mod");
});
