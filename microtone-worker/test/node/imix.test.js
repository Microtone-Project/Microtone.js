// Item 217 — per-instrument mixing chains (IMix): the section codec and its
// validation, the equipment's behaviour measured on rendered signals, the
// engine's routing (and its bit-exactness when no chain is engaged), and the
// document: ops, undo, save-time retirement, bank import.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as M from "../../core/engine/imix.js";
import {
  parseImixSection, buildImixSection, buildImixBlock, encodeEquipment, freeImixId, IMIX_FOURCC,
  imixWithFolded, imixCarryFolds,
} from "../../core/format/imix-section.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";
import { TaudInst, buildMetaRecord, makeMetaLayer } from "../../core/engine/inst.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine, renderSong } from "../../core/audio/offline-render.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { setImixOp, setInstFieldOp, compositeOp } from "../../src/doc/ops.js";
import { planImport, applyPlan } from "../../src/doc/bankmerge.js";

const FS = 48000;
const DEMO = new URL("../../assets/demo_projects/Huygens_clock.taud", import.meta.url).pathname;

/** A block with every piece of equipment inserted at its defaults. */
function fullBlock(id = 1) {
  const b = M.defaultImixBlock(id);
  for (const eq of M.IMX_EQUIPMENT) b.equipment[eq] = M.defaultEquipment(eq);
  return b;
}

/** Run one piece of equipment over a stereo signal; returns interleaved output. */
function runOne(eq, mod, sig, frames = FS, chunk = 128, opts = {}) {
  const block = M.defaultImixBlock(1);
  block.equipment[eq] = mod(M.defaultEquipment(eq));
  const ch = new M.InstrumentChain(block, FS, 2, true);
  const out = new Float64Array(frames * 2);
  const buf = new Float64Array(2 * chunk);
  for (let s = 0; s < frames; s += chunk) {
    const n1 = Math.min(chunk, frames - s);
    for (let n = 0; n < n1; n++) {
      const [l, r] = sig(s + n);
      buf[n] = l; buf[chunk + n] = r;
    }
    ch.process(buf, chunk, 0, n1, opts.bpm ?? 125, true);
    for (let n = 0; n < n1; n++) { out[(s + n) * 2] = buf[n]; out[(s + n) * 2 + 1] = buf[chunk + n]; }
  }
  return { out, chain: ch };
}

const sine = (hz, a = 0.5) => (n) => { const v = a * Math.sin((2 * Math.PI * hz * n) / FS); return [v, v]; };
const impulse = (n) => (n === 0 ? [1, 1] : [0, 0]);
const rmsDb = (out, from, to, c = 0) => {
  let s = 0;
  for (let n = from; n < to; n++) s += out[n * 2 + c] ** 2;
  return 10 * Math.log10(s / (to - from) + 1e-300);
};

// ── the codec ───────────────────────────────────────────────────────────────

test("a full block round-trips through the section, every field binary32-stable", () => {
  const b = fullBlock(7);
  b.order = 1;
  b.equipment.equ1.bands[0].shape = M.IMX_EQ_HIGH_PASS;
  b.equipment.equ1.bands[0].slope = 2;
  b.equipment.comp.bands = [M.defaultCompBand(), M.defaultCompBand(), M.defaultCompBand()];
  b.equipment.comp.crossovers = [150, 2500];
  b.equipment.deq2.bands[3] = { ...b.equipment.deq2.bands[3], on: true, unlinked: true, senseFreq: 5000, senseQ: 2 };
  b.equipment.unis.widthLfo = { wave: M.IMX_LFO_RANDOM, retrigger: true, sync: true, rate: 24 * M.FX16, depth: 0.3 };
  b.equipment.dlay.pingPong = true;
  b.equipment.satu.dry = 40;
  const payload = buildImixSection([b]);
  const { blocks, problems } = parseImixSection(payload);
  assert.deepEqual(problems, []);
  const back = blocks.get(7);
  assert.ok(M.imixBlockEqual(back, b));
  // …and a second trip writes the same bytes: the document holds what the file does.
  assert.deepEqual(buildImixSection([back]), payload);
  assert.equal(back.equipment.unis.widthLfo.rate, 24 * M.FX16, "16.16 fields stay integers");
});

test("the block header is the one item 217 specifies", () => {
  const b = M.defaultImixBlock(3);
  b.order = 1;
  b.equipment.itrm = M.defaultEquipment("itrm");
  b.equipment.mxtl = M.defaultEquipment("mxtl");
  const bytes = buildImixBlock(b);
  assert.equal(bytes[0], 3, "id");
  assert.equal(bytes[1], 0, "reserved");
  assert.equal(bytes[2], 0x11, "0b nnnn 000e: order 1, enabled");
  assert.equal(bytes[3], 2, "equipment count");
  assert.equal(String.fromCharCode(...bytes.subarray(4, 8)), "itrm");
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), "mxtl");
  // First record: FourCC, U32 size (common bytes included), payload.
  assert.equal(String.fromCharCode(...bytes.subarray(12, 16)), "itrm");
  assert.equal(bytes[16] | (bytes[17] << 8), 8);
  // Bypass is bit 7 of the first common byte, the version its low nibble.
  const byp = encodeEquipment("itrm", { ...M.defaultEquipment("itrm"), bypass: true });
  assert.equal(byp[0], 0x80);
});

test("contradictions make a block INVALID; it is dropped, the rest survive", () => {
  const good = buildImixBlock({ ...fullBlock(2) });
  const mk = (patch) => {
    const b = buildImixBlock({ ...M.defaultImixBlock(5), equipment: { itrm: M.defaultEquipment("itrm"), verb: M.defaultEquipment("verb") } });
    patch(b);
    return b;
  };
  const cases = {
    "id 0": (b) => { b[0] = 0; },
    "undefined order": (b) => { b[2] = 0x21; },
    "list disagrees": (b) => { b[4] = "x".charCodeAt(0); },
    "wet/dry on a trim": (b) => { b[4 + 8 + 8 + 1] = 9; },
  };
  for (const [name, patch] of Object.entries(cases)) {
    const bad = mk(patch);
    const section = new Uint8Array(bad.length + good.length);
    section.set(bad); section.set(good, bad.length);
    const { blocks, problems } = parseImixSection(section);
    assert.ok(problems.some((p) => p.kind === "invalid"), `${name}: reported`);
    assert.ok(!blocks.has(5) && !blocks.has(0), `${name}: dropped`);
    assert.ok(blocks.has(2), `${name}: the next block still reads`);
  }
  // Two blocks under one id: neither is THE block.
  const dup = buildImixSection([fullBlock(4)]);
  const two = new Uint8Array(dup.length * 2);
  two.set(dup); two.set(dup, dup.length);
  const r = parseImixSection(two);
  assert.ok(!r.blocks.has(4));
  assert.ok(r.problems.some((p) => /two blocks/.test(p.detail)));
});

test("crossovers out of order, a linked band sensing elsewhere, and a slope on a bell are contradictions", () => {
  const withComp = (f) => {
    const b = M.defaultImixBlock(1);
    b.equipment.comp = { ...M.defaultEquipment("comp"), bands: [M.defaultCompBand(), M.defaultCompBand(), M.defaultCompBand()], crossovers: [300, 3000] };
    const bytes = buildImixBlock(b);
    f(new DataView(bytes.buffer));
    return parseImixSection(bytes);
  };
  // payload starts after header (4) + list (4) + fourcc (4) + size (4) = 16
  assert.ok(withComp((dv) => dv.setFloat32(16 + 8 + 4, 100, true)).problems[0].kind === "invalid");
  const deq = M.defaultImixBlock(1);
  deq.equipment.deq1 = M.defaultEquipment("deq1");
  const db = buildImixBlock(deq);
  new DataView(db.buffer).setFloat32(16 + 8 + 16, 1234, true); // band 0 senseFreq, still linked
  assert.equal(parseImixSection(db).problems[0].kind, "invalid");
  const eq = M.defaultImixBlock(1);
  eq.equipment.equ1 = M.defaultEquipment("equ1");
  const eb = buildImixBlock(eq);
  eb[16 + 8 + 16 + 2] = 1; // band 1 (a bell) given a slope
  assert.equal(parseImixSection(eb).problems[0].kind, "invalid");
});

test("unknown equipment is kept verbatim, written back, skipped by playback, and reported", () => {
  const b = M.defaultImixBlock(9);
  b.equipment.itrm = M.defaultEquipment("itrm");
  b.unknown = [{ fourcc: "fuzz", bytes: Uint8Array.of(0, 0, 0, 0, 1, 2, 3) },
    { fourcc: "verb", bytes: Uint8Array.of(1, 0, 0, 0, 9, 9) }]; // a known id at version 1
  // build lists known first, then unknown in order
  const bytes = buildImixSection([b]);
  const { blocks, problems } = parseImixSection(bytes);
  assert.deepEqual(problems.map((p) => [p.kind, p.id, p.detail]), [["unknown", 9, ["fuzz", "verb v1"]]]);
  const back = blocks.get(9);
  assert.equal(back.unknown.length, 2);
  assert.ok(!back.equipment.verb, "a version-1 reverb is not read as a version-0 one");
  assert.deepEqual(buildImixSection([back]), bytes);
  assert.equal(M.imixBlockEngaged({ ...back, equipment: {} }), false, "unknown equipment alone makes no bus");
});

test("out-of-range values are clamped, not rejected", () => {
  const b = M.normaliseImixBlock({ id: 1, equipment: {
    itrm: { gainDb: 99 }, verb: { decay: -5, size: 2 }, dlay: { sync: false, time: 1e12 },
  } });
  assert.equal(b.equipment.itrm.gainDb, 24);
  assert.equal(b.equipment.verb.decay, Math.fround(0.1));
  assert.equal(b.equipment.verb.size, 1);
  assert.equal(b.equipment.dlay.time, M.IMX_DELAY_MAX_SEC * M.FX16);
  assert.equal(b.equipment.itrm.dry, 0, "a trim's wet/dry is always 0");
});

test("freeImixId hands out the lowest free id, and 0 when all 255 are taken", () => {
  assert.equal(freeImixId(new Set()), 1);
  assert.equal(freeImixId(new Set([1, 2, 4])), 3);
  assert.equal(freeImixId(new Set(Array.from({ length: 255 }, (_, i) => i + 1))), 0);
});

// ── the equipment ───────────────────────────────────────────────────────────

test("LFO increments are the specified integer formulas", () => {
  // Hz: floor(R · 2^16 / fs).
  assert.equal(M.lfoIncrement(false, M.FX16, 125, FS), Math.floor(2 ** 32 / FS));
  // Sync: floor(2^51 · bpm / (5 · P · fs)) — one cycle per P quarter ticks.
  const P = 24 * M.FX16;
  const inc = M.lfoIncrement(true, P, 125, FS);
  assert.equal(BigInt(inc), (1n << 51n) * 125n / (5n * BigInt(P) * 48000n));
  const samplesPerCycle = (24 / 4) * (FS * 2.5 / 125);
  assert.ok(Math.abs(inc * samplesPerCycle - 2 ** 32) < samplesPerCycle, "a cycle is 24 quarter ticks long");
});

test("input trim and mix tool: exact gain, swap, polarity, width", () => {
  const { out } = runOne("itrm", (e) => ({ ...e, gainDb: -6 }), () => [0.5, -0.25], 256);
  assert.ok(Math.abs(out[200] - 0.5 * 10 ** (-6 / 20)) < 1e-15);
  const { out: m } = runOne("mxtl", (e) => ({ ...e, swap: true, invR: true }), () => [0.5, -0.25], 256);
  assert.equal(m[200], -0.25);
  assert.equal(m[201], -0.5);
  const { out: w } = runOne("mxtl", (e) => ({ ...e, width: 0 }), () => [0.5, -0.25], 256);
  assert.ok(Math.abs(w[200] - w[201]) < 1e-15, "width 0 is mono");
});

test("equaliser: a bell boosts its frequency and leaves a distant one alone", () => {
  const set = (e) => ({ ...e, bands: [{ on: true, shape: M.IMX_EQ_BELL, slope: 0, freq: 1000, gainDb: 12, q: 1 }] });
  const at = runOne("equ1", set, sine(1000)).out;
  const far = runOne("equ1", set, sine(60)).out;
  assert.ok(Math.abs(rmsDb(at, 24000, 48000) - (rmsDb(runOne("itrm", (e) => e, sine(1000)).out, 24000, 48000) + 12)) < 0.1);
  assert.ok(Math.abs(rmsDb(far, 24000, 48000) - (10 * Math.log10(0.125))) < 0.2);
  // A 48 dB/octave high-pass two octaves below its corner: ~ −96 dB.
  const hp = runOne("equ1", (e) => ({ ...e, bands: [{ on: true, shape: M.IMX_EQ_HIGH_PASS, slope: 3, freq: 400, gainDb: 0, q: 0.7 }] }), sine(100)).out;
  assert.ok(rmsDb(hp, 24000, 48000) < -9 - 85);
});

test("compressor: reduces above threshold, its multiband split sums flat when idle", () => {
  const loud = runOne("comp", (e) => e, sine(500)).out;
  assert.ok(rmsDb(loud, 24000, 48000) < rmsDb(runOne("itrm", (e) => e, sine(500)).out, 24000, 48000) - 3);
  // Three bands, nothing to compress: the bands must sum back to the input's level.
  const flat = runOne("comp", (e) => ({
    ...e, crossovers: [200, 2000],
    bands: [1, 2, 3].map(() => ({ ...M.defaultCompBand(), threshDb: 0 })),
  }), sine(1000, 0.1)).out;
  assert.ok(Math.abs(rmsDb(flat, 24000, 48000) - 10 * Math.log10(0.005)) < 0.05);
});

test("dynamic EQ: a cut band moves only when its sensor crosses the threshold", () => {
  const set = (e) => {
    e.bands[2] = { ...e.bands[2], on: true, freq: 1000, senseFreq: 1000, threshDb: -30, ratio: 4, rangeDb: 12 };
    return e;
  };
  const r = runOne("deq1", set, sine(1000, 0.5));
  assert.ok(rmsDb(r.out, 24000, 48000) < -9 - 6, "a loud tone at the band is cut");
  const quiet = runOne("deq1", set, sine(1000, 0.001));
  assert.ok(Math.abs(rmsDb(quiet.out, 24000, 48000) - 10 * Math.log10(0.0000005)) < 0.2, "a quiet one is not");
});

test("saturator: bounded, and every curve's antiderivative path stays finite", () => {
  for (let c = 0; c < M.IMX_SAT_CURVES; c++) {
    const { out } = runOne("satu", (e) => ({ ...e, curve: c, driveDb: 36 }), sine(220, 1), 9600);
    const peak = Math.max(...out.map(Math.abs));
    assert.ok(Number.isFinite(peak) && peak <= 1.05, `curve ${c}: ${peak}`);
  }
});

test("tape delay: the echo lands on the exact sample, in seconds and in quarter ticks", () => {
  const flat = (e) => ({ ...e, feedback: 0, wow: 0, dry: 0, lowCut: 20, highCut: 20000 });
  const first = (out) => { for (let n = 0; n < out.length / 2; n++) if (Math.abs(out[n * 2]) > 0.1) return n; return -1; };
  assert.equal(first(runOne("dlay", (e) => ({ ...flat(e), sync: false, time: M.FX16 / 10 }), impulse, 9600).out), 4800);
  // 48 quarter ticks at 125 BPM: a tick is 960 samples, so 11520.
  assert.equal(first(runOne("dlay", flat, impulse, 24000).out), 11520);
  assert.equal(first(runOne("dlay", flat, impulse, 24000, 128, { bpm: 250 }).out), 5760, "…and halves at twice the tempo");
});

test("reverb: the tail decays at the requested RT60", () => {
  const { out } = runOne("verb", (e) => ({ ...e, dry: 0, decay: 1, damping: 20000, preDelay: 0 }), impulse, FS * 2);
  const a = rmsDb(out, 9600, 14400), b = rmsDb(out, 57600, 62400);
  const perSec = (a - b);  // 1 s apart
  assert.ok(perSec > 50 && perSec < 70, `${perSec.toFixed(1)} dB/s for a 1 s decay`);
});

test("limiter: never past its ceiling", () => {
  const { out } = runOne("limi", (e) => ({ ...e, gainDb: 18, ceilingDb: -3 }), sine(997, 0.9));
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak <= 10 ** (-3 / 20) + 1e-12, String(peak));
});

test("unison: copies spread across the pair and the spacing law holds", () => {
  const { out } = runOne("unis", (e) => ({ ...e, width: 1, detune: 30 }), (n) => [Math.sin(n * 0.05) * 0.3, 0]);
  assert.ok(rmsDb(out, 24000, 48000, 1) > -40, "a left-only input reaches the right through the spread");
  const u = M.unisonPositions(4, 0), bell = M.unisonPositions(4, 1);
  assert.deepEqual([...u].map((x) => +x.toFixed(6)), [-1, -1 / 3, 1 / 3, 1].map((x) => +x.toFixed(6)));
  assert.ok(Math.abs(bell[1]) < Math.abs(u[1]), "the bell gathers the inner voices toward the centre");
  assert.deepEqual([...M.unisonPositions(3, 1)], [...M.unisonPositions(3, 0)], "below four voices spacing is moot");
});

test("a chain's output does not depend on how the bus is cut into spans", () => {
  const b = fullBlock();
  b.equipment.unis.detuneLfo.depth = 0.7;
  b.equipment.deq1.bands[3].on = true;
  const run = (chunk) => {
    const ch = new M.InstrumentChain(b, FS, 2, true);
    const out = [];
    const buf = new Float64Array(2 * 512);
    for (let s = 0; s < 20000; s += chunk) {
      for (let n = 0; n < chunk; n++) { const v = 0.4 * Math.sin((s + n) * 0.031) * (((s + n) >> 11) & 1); buf[n] = v; buf[512 + n] = -v; }
      ch.process(buf, 512, 0, chunk, 125, true);
      for (let n = 0; n < chunk; n++) out.push(buf[n], buf[512 + n]);
    }
    return out;
  };
  const a = run(128), c = run(37 * 2 + 6), d = run(500);
  const n = Math.min(a.length, c.length, d.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== c[i] || a[i] !== d[i]) assert.fail(`sample ${i}: ${a[i]} / ${c[i]} / ${d[i]}`);
  }
});

test("a chain fed silence goes idle — exactly zero — after every delay inside it has drained", () => {
  const b = M.defaultImixBlock(1);
  b.equipment.verb = { ...M.defaultEquipment("verb"), decay: 0.3 };
  const ch = new M.InstrumentChain(b, FS, 2, true);
  const buf = new Float64Array(256);
  let last = 0;
  for (let s = 0; s < FS * 3; s += 128) {
    for (let n = 0; n < 128; n++) { const v = s < 4800 ? Math.sin(n) * 0.5 : 0; buf[n] = v; buf[128 + n] = v; }
    ch.process(buf, 128, 0, 128, 125, true);
    if (!ch.idle) last = s;
  }
  assert.ok(ch.idle);
  assert.ok(last < FS * 2.5);
});

// ── the engine ──────────────────────────────────────────────────────────────

async function render(prep, seconds = 6) {
  setRandomSource(makeSeededRandom(1));
  try {
    const doc = parseTaud(await readFile(DEMO));
    const eng = new TaudEngine();
    loadIntoEngine(eng, doc, 0);
    prep?.(eng);
    return renderSong(eng, seconds);
  } finally { setRandomSource(null); }
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test("a chain that is off, or holds only bypassed equipment, renders bit-for-bit as no chain", async () => {
  const plain = await render(null);
  const off = fullBlock(1); off.enabled = false;
  const byp = fullBlock(2);
  for (const k of Object.keys(byp.equipment)) byp.equipment[k].bypass = true;
  const put = (eng) => {
    eng.setImix([off, byp]);
    for (let s = 1; s < 32; s++) eng.instruments[s].imixId = s & 1 ? 1 : 2;
    eng.imixGen++;
  };
  const r = await render(put);
  assert.ok(same(plain.f32, r.f32), "f32 bus");
  assert.ok(same(plain.u8, r.u8), "device output");
});

test("an engaged chain changes the instruments that name it, deterministically", async () => {
  const b = M.defaultImixBlock(1);
  b.equipment.itrm = { ...M.defaultEquipment("itrm"), gainDb: -12 };
  const put = (eng) => { eng.setImix([b]); for (let s = 1; s < 64; s++) eng.instruments[s].imixId = 1; eng.imixGen++; };
  const plain = await render(null);
  const a = await render(put), c = await render(put);
  assert.ok(!same(plain.f32, a.f32));
  assert.ok(same(a.f32, c.f32));
  let pp = 0, pa = 0;
  for (let i = 0; i < plain.f32.length; i++) { pp += plain.f32[i] ** 2; pa += a.f32[i] ** 2; }
  assert.ok(Math.abs(10 * Math.log10(pa / pp) + 12) < 0.5, "−12 dB of trim on every instrument is −12 dB of mix");
});

test("the chain is pushed through loadIntoEngine from a parsed file", async () => {
  const doc = new Document(parseTaud(await readFile(DEMO)));
  const slot = doc.selectableInstrumentSlots()[0];
  new UndoStack(doc, () => {}).apply(compositeOp([
    setImixOp(doc.imixPayloadWith(1, fullBlock(1))), setInstFieldOp(slot, "imixId", 1),
  ]));
  const parsed = parseTaud(doc.toBytes());
  assert.equal(parsed.imix.length, 1);
  const eng = new TaudEngine();
  loadIntoEngine(eng, parsed, 0);
  assert.equal(eng.getImix().length, 1);
  assert.equal(eng.instruments[slot].imixId, 1);
});

test("byte 255 is every record kind's IMix id, and a meta repack keeps it", () => {
  const meta = new TaudInst(5);
  meta.loadRecord(buildMetaRecord([makeMetaLayer(1, 159, 0, 0, 0xffff, 0, 63)], { imixId: 42 }));
  assert.equal(meta.imixId, 42);
  meta.imixId = 7;
  assert.equal(meta.getByte(255), 7);
  const plain = new TaudInst(6);
  const rec = new Uint8Array(256); rec[255] = 9;
  plain.loadRecord(rec);
  assert.equal(plain.imixId, 9);
  assert.equal(plain.getByte(255), 9);
});

// ── the document ────────────────────────────────────────────────────────────

test("a save retires the blocks no instrument names, and keeps the rest byte for byte", async () => {
  const doc = new Document(parseTaud(await readFile(DEMO)));
  const undo = new UndoStack(doc, () => {});
  const [a, b] = doc.selectableInstrumentSlots();
  undo.apply(compositeOp([
    setImixOp(doc.imixPayloadWith(1, fullBlock(1))),
    setInstFieldOp(a, "imixId", 1),
  ]));
  undo.apply(compositeOp([
    setImixOp(doc.imixPayloadWith(2, fullBlock(2))),
    setInstFieldOp(b, "imixId", 2),
  ]));
  undo.apply(setInstFieldOp(b, "imixId", 0));
  assert.ok(doc.imixBlock(2), "the session keeps the block");
  const saved = parseTaud(doc.toBytes());
  assert.deepEqual(saved.imix.map((x) => x.id), [1]);
  // Nothing to retire: the section is written back verbatim.
  const again = new Document(saved);
  const sec = (d) => d.projSections.find((s) => s.fourcc === IMIX_FOURCC).payload;
  assert.deepEqual([...sec(new Document(parseTaud(again.toBytes())))], [...sec(again)]);
  // No block named at all: no section.
  undo.apply(setInstFieldOp(a, "imixId", 0));
  assert.ok(!parseTaud(doc.toBytes()).projSections.some((s) => s.fourcc === IMIX_FOURCC));
});

test("a bank import brings each chain under a fresh id, shared chains still shared", async () => {
  const src = new Document(parseTaud(await readFile(DEMO)));
  const dest = new Document(parseTaud(await readFile(DEMO)));
  const su = new UndoStack(src, () => {});
  const [a, b] = src.selectableInstrumentSlots();
  su.apply(compositeOp([setImixOp(src.imixPayloadWith(1, fullBlock(1))),
    setInstFieldOp(a, "imixId", 1), setInstFieldOp(b, "imixId", 1)]));
  // The destination already uses id 1 for something else.
  const du = new UndoStack(dest, () => {});
  const other = M.defaultImixBlock(1); other.equipment.itrm = M.defaultEquipment("itrm");
  du.apply(setImixOp(dest.imixPayloadWith(1, other)));
  src._rebuildInstRegion();
  const plan = planImport(dest, src, [a, b]);
  assert.ok(!plan.error, plan.error);
  applyPlan(dest, plan);
  const ids = plan.insts.filter((it) => it.topLevel).map((it) => dest.instruments[it.destSlot].imixId);
  assert.deepEqual(ids, [2, 2], "one fresh id, both instruments on it");
  assert.ok(M.imixBlockEqual({ ...dest.imixBlock(2), id: 1 }, fullBlock(1)));
  assert.ok(M.imixBlockEqual(dest.imixBlock(1), other), "the destination's own block 1 is untouched");
});

test("the snapshot carries the Mixing tab's block for the metered instrument", async () => {
  const { fillSnapshotInto } = await import("../../core/worklet/engine-commands.js");
  const P = await import("../../core/worklet/protocol.js");
  const doc = parseTaud(await readFile(DEMO));
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc, 0);
  const b = M.defaultImixBlock(1);
  b.equipment.limi = M.defaultEquipment("limi");
  b.equipment.comp = M.defaultEquipment("comp");
  b.equipment.unis = M.defaultEquipment("unis");
  b.equipment.equ1 = { ...M.defaultEquipment("equ1"), bypass: true };
  eng.setImix([b]);
  for (let s = 1; s < 64; s++) eng.instruments[s].imixId = 1;
  eng.imixGen++;
  eng.setCuePosition(0, 0);
  eng.play(0);
  const dev = new Uint8Array(TRACKER_CHUNK * 2);
  const ts = eng.playheads[0].trackerState;
  let slot = 0;
  for (let i = 0; i < 2000 && slot === 0; i++) {
    eng.renderChunk(0, dev);
    const v = ts.voices.find((x) => x.active);
    if (v) slot = (v.displayInst || v.instrumentId) & 0x3ff;
  }
  assert.ok(slot > 0, "something is sounding");
  eng.setImixMeter(0, slot);
  for (let i = 0; i < 40; i++) eng.renderChunk(0, dev);
  const f = new Float32Array(P.SNAP_FLOATS);
  fillSnapshotInto(eng, 0, f);
  assert.equal(f[P.SNAP_IM_BASE + P.SNAP_IM_SLOT], slot);
  assert.ok(f[P.SNAP_IM_BASE + P.SNAP_IM_FRAMES] > 0);
  let energy = 0;
  for (let i = 0; i < 2 * P.SNAP_IM_RING_FRAMES; i++) energy += f[P.SNAP_IM_BASE + P.SNAP_IM_RING + i] ** 2;
  assert.ok(energy > 0, "the post-chain ring holds the instrument");
  const ringEnergy = (id) => {
    const o = P.SNAP_IM_BASE + P.SNAP_IM_STAGE_RINGS + M.IMX_TAP_STAGES.indexOf(id) * P.SNAP_IM_RING_FRAMES;
    let e = 0;
    for (let i = 0; i < P.SNAP_IM_RING_FRAMES; i++) e += f[o + i] ** 2;
    return e;
  };
  assert.ok(ringEnergy("comp") > 0, "the compressor's input is rung");
  assert.equal(ringEnergy("equ1"), 0, "a bypassed equaliser has no input of its own");
  assert.equal(ringEnergy("deq2"), 0, "nor has a piece that is not in the chain");
  const cents = f[P.SNAP_IM_BASE + P.SNAP_IM_UNIS_CENTS];
  assert.ok(Math.abs(cents - 15) < 1e-4, `the unison's live detune (${cents})`);
  assert.ok(Math.abs(f[P.SNAP_IM_BASE + P.SNAP_IM_UNIS_WIDTH] - 0.8) < 1e-6, "…and width");
  const lvl = f[P.SNAP_IM_BASE + P.SNAP_IM_COMP_LVL];
  assert.ok(lvl > -120 && lvl <= 6, `the compressor's detector level is carried (${lvl} dB)`);
  assert.equal(f[P.SNAP_IM_BASE + P.SNAP_IM_DEQ1_LVL], -120, "an absent dynamic EQ reads nothing");
  eng.setImixMeter(0, -1);
  fillSnapshotInto(eng, 0, f);
  assert.equal(f[P.SNAP_IM_BASE + P.SNAP_IM_FRAMES], 0, "the tap is gone");
});

test("display responses: a compressor at rest is its make-up, and its bands sum flat", () => {
  const e = M.defaultEquipment("comp");
  e.bands = [M.defaultCompBand(), M.defaultCompBand(), M.defaultCompBand()];
  e.crossovers = M.defaultCrossovers(3);
  e.bands.forEach((x) => { x.makeupDb = 3; });
  const chain = new M.InstrumentChain({ id: 1, enabled: true, order: 0, equipment: { comp: e }, unknown: [] });
  for (const f of [30, 200, 1000, 5000, 15000]) {
    assert.ok(Math.abs(chain.stageResponseDb("comp", f) - 3) < 1e-6, `flat +3 dB at ${f} Hz`);
  }
  chain.showGains("comp", new Float64Array([0, 0, -12, 0, 0, 0]));
  assert.ok(chain.stageResponseDb("comp", 15000) < -8, "the top band's reduction shows above its crossover");
  assert.ok(Math.abs(chain.stageResponseDb("comp", 30) - 3) < 0.1, "…and not at the bottom");
  // The saturator's transfer: odd curves through the origin, and all dry is the identity.
  const sat = M.defaultEquipment("satu");
  assert.equal(M.imxSatTransfer(sat, 0), 0);
  assert.ok(Math.abs(M.imxSatTransfer(sat, 0.5) + M.imxSatTransfer(sat, -0.5)) < 1e-12);
  assert.equal(M.imxSatTransfer({ ...sat, dry: 255 }, 0.3), 0.3);
});

test("the folded flag: bit 6 beside the bypass, set in place, out of the undo history", async () => {
  const b = fullBlock(3);
  b.equipment.comp.folded = true;
  b.equipment.verb.bypass = true;
  const payload = buildImixSection([b]);
  const back = parseImixSection(payload).blocks.get(3);
  assert.equal(back.equipment.comp.folded, true, "decoded");
  assert.equal(back.equipment.verb.folded, false);
  assert.equal(back.equipment.verb.bypass, true, "…beside an untouched bypass");
  assert.ok(M.imixBlockEqual(back, { ...back, equipment: { ...back.equipment, comp: { ...back.equipment.comp, folded: false } } }),
    "a block that differs only in folding is the same chain");

  // In place: one byte moves, and nothing else in the section.
  const f = imixWithFolded(payload, 3, "verb", true);
  assert.notEqual(f, payload);
  assert.equal([...f].filter((x, i) => x !== payload[i]).length, 1, "exactly one byte changes");
  assert.equal(parseImixSection(f).blocks.get(3).equipment.verb.folded, true);
  assert.equal(parseImixSection(f).blocks.get(3).equipment.verb.bypass, true, "the bypass bit stays");
  assert.equal(imixWithFolded(payload, 3, "comp", true), payload, "already folded: the same payload back");
  assert.equal(imixWithFolded(payload, 9, "comp", false), payload, "no such block: unchanged");

  // Carrying: a replacement takes the folds standing now.
  const other = buildImixSection([fullBlock(3)]);
  const carried = imixCarryFolds(other, f);
  const cb = parseImixSection(carried).blocks.get(3);
  assert.equal(cb.equipment.comp.folded, true);
  assert.equal(cb.equipment.verb.folded, true);
  assert.equal(cb.equipment.verb.bypass, false, "only the fold is carried");

  // Through the document: a fold is no undo step, and undoing an edit keeps it.
  const doc = new Document(parseTaud(await readFile(DEMO)));
  doc.setSection(IMIX_FOURCC, payload);
  doc.dirty = false;
  const undo = new UndoStack(doc);
  const edited = { ...doc.imixBlock(3) };
  edited.equipment = { ...edited.equipment, itrm: { ...edited.equipment.itrm, gainDb: 6 } };
  undo.apply(setImixOp(doc.imixPayloadWith(3, edited)));
  assert.equal(doc.setImixFolded(3, "itrm", true), true);
  assert.equal(doc.dirty, true, "folding marks the file unsaved");
  assert.equal(undo.undoStack.length, 1, "…but takes no undo step");
  undo.undo();
  assert.equal(doc.imixBlock(3).equipment.itrm.gainDb, 0, "the edit is undone");
  assert.equal(doc.imixBlock(3).equipment.itrm.folded, true, "…and the fold made since stays");
  undo.redo();
  assert.equal(doc.imixBlock(3).equipment.itrm.folded, true, "…through the redo too");
  assert.equal(doc.setImixFolded(3, "nope", true), false, "a piece the block lacks: nothing to fold");
});
