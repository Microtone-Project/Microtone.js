// Item 247 — the mixing chains' two modes (separate / bus), the chains' names
// (IMcn) and the mix tool's DC blocker.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as M from "../../core/engine/imix.js";
import {
  parseImixSection, buildImixSection, buildImixBlock, encodeEquipment, IMCN_FOURCC,
} from "../../core/format/imix-section.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine, renderSong } from "../../core/audio/offline-render.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { setImixOp, setInstFieldOp, setSectionOp, compositeOp } from "../../src/doc/ops.js";
import { planImport, applyPlan } from "../../src/doc/bankmerge.js";

const FS = 48000;
const DEMO = new URL("../../assets/demo_projects/Huygens_clock.taud", import.meta.url).pathname;

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
const energy = (a) => { let e = 0; for (const v of a) e += v * v; return e; };

/** Put every instrument 1…63 on one block. */
const allOn = (block) => (eng) => {
  eng.setImix([block]);
  for (let s = 1; s < 64; s++) eng.instruments[s].imixId = block.id;
  eng.imixGen++;
};

// ── the codec ───────────────────────────────────────────────────────────────

test("the mode is bit 1 of the status byte: 0b nnnn 00be", () => {
  const b = M.defaultImixBlock(4);
  b.equipment.itrm = M.defaultEquipment("itrm");
  assert.equal(buildImixBlock(b)[2], 0x01, "separate: enabled only");
  b.bus = true;
  b.order = 1;
  const bytes = buildImixBlock(b);
  assert.equal(bytes[2], 0x13, "order 1, bus, enabled");
  const back = parseImixSection(bytes).blocks.get(4);
  assert.equal(back.bus, true);
  assert.equal(back.order, 1);
  assert.ok(M.imixBlockEqual(back, b));
  assert.ok(!M.imixBlockEqual(back, { ...b, bus: false }), "the mode is part of the chain");
  assert.equal(M.normaliseImixBlock({ id: 1 }).bus, false, "a block says separate unless it says otherwise");
});

test("the mix tool's Remove DC is bit 3 of its flags", () => {
  const e = { ...M.defaultEquipment("mxtl"), removeDc: true, swap: true };
  const bytes = encodeEquipment("mxtl", e);
  assert.equal(bytes[4], 0x09);
  const b = M.defaultImixBlock(1);
  b.equipment.mxtl = e;
  const back = parseImixSection(buildImixSection([b])).blocks.get(1).equipment.mxtl;
  assert.equal(back.removeDc, true);
  assert.equal(back.swap, true);
  assert.equal(M.defaultEquipment("mxtl").removeDc, false);
});

// ── Remove DC ───────────────────────────────────────────────────────────────

function runMix(e, sig, frames, chunk = 128) {
  const block = M.defaultImixBlock(1);
  block.equipment.mxtl = { ...M.defaultEquipment("mxtl"), ...e };
  const ch = new M.InstrumentChain(block, FS, 2, true);
  const out = new Float64Array(frames * 2);
  const buf = new Float64Array(2 * chunk);
  for (let s = 0; s < frames; s += chunk) {
    const n1 = Math.min(chunk, frames - s);
    for (let n = 0; n < n1; n++) { const [l, r] = sig(s + n); buf[n] = l; buf[chunk + n] = r; }
    ch.process(buf, chunk, 0, n1, 125, true);
    for (let n = 0; n < n1; n++) { out[(s + n) * 2] = buf[n]; out[(s + n) * 2 + 1] = buf[chunk + n]; }
  }
  return out;
}

test("Remove DC is Opus's dc_reject: y = x − m, m = a·x + (1 − a)·m, a = 6.3 × 3 ÷ fs", () => {
  const a = (6.3 * 3) / FS;
  const out = runMix({ removeDc: true }, () => [0.5, -0.25], 4);
  assert.equal(out[0], 0.5, "the first sample passes: m starts at 0");
  assert.equal(out[2], 0.5 - a * 0.5);
  assert.equal(out[3], -0.25 - a * -0.25, "each channel its own memory");
  // An offset is gone within a second; a 1 kHz tone is not touched.
  const dc = runMix({ removeDc: true }, () => [0.5, 0.5], FS);
  assert.ok(Math.abs(dc[(FS - 1) * 2]) < 1e-6, String(dc[(FS - 1) * 2]));
  const tone = (n) => { const v = 0.5 * Math.sin((2 * Math.PI * 1000 * n) / FS); return [v + 0.2, v + 0.2]; };
  const t = runMix({ removeDc: true }, tone, FS);
  let mean = 0, peak = 0;
  for (let n = FS / 2; n < FS; n++) { mean += t[n * 2]; peak = Math.max(peak, Math.abs(t[n * 2])); }
  assert.ok(Math.abs(mean / (FS / 2)) < 1e-4, "the offset is removed");
  assert.ok(Math.abs(peak - 0.5) < 0.005, `the tone is kept (${peak})`);
  // Off, nothing moves.
  const off = runMix({}, () => [0.5, -0.25], 256);
  assert.equal(off[200], 0.5);
});

test("Remove DC does not depend on where the bus is cut", () => {
  const sig = (n) => [Math.sin(n * 0.01) + 0.3, Math.cos(n * 0.013) - 0.2];
  const a = runMix({ removeDc: true }, sig, 4000, 128);
  const b = runMix({ removeDc: true }, sig, 4000, 37);
  assert.ok(same(a, b));
});

// ── bus mode in the engine ──────────────────────────────────────────────────

test("bus mode gives every instrument on a block ONE bus, at the first one's place", () => {
  const eng = new TaudEngine();
  const b = M.defaultImixBlock(1);
  b.bus = true;
  b.equipment.itrm = M.defaultEquipment("itrm");
  const c = M.defaultImixBlock(2);
  c.equipment.itrm = M.defaultEquipment("itrm");
  eng.setImix([b, c]);
  for (const s of [3, 5, 9]) eng.instruments[s].imixId = 1;
  for (const s of [4, 7]) eng.instruments[s].imixId = 2;
  eng.imixGen++;
  eng.setCuePosition(0, 0);
  eng.play(0);
  const ts = eng.playheads[0].trackerState;
  M.syncImixRoutes(eng, ts);
  const shared = ts.imixRoutes[3];
  assert.ok(shared !== null);
  assert.equal(ts.imixRoutes[5], shared);
  assert.equal(ts.imixRoutes[9], shared);
  assert.deepEqual(shared.slots, [3, 5, 9]);
  assert.equal(shared.slot, 3);
  assert.notEqual(ts.imixRoutes[4], ts.imixRoutes[7], "a separate block: one bus each");
  assert.deepEqual(ts.imixList.map((x) => x.slot), [3, 4, 7], "ascending by the bus's first slot");
  // Switching the mode keeps the first slot's bus (and its tails).
  b.bus = false;
  eng.setImix([b, c]);
  M.syncImixRoutes(eng, ts);
  assert.equal(ts.imixRoutes[3], shared);
  assert.deepEqual(shared.slots, [3]);
  assert.notEqual(ts.imixRoutes[5], shared);
});

test("a linear chain sounds the same in either mode; a compressor does not", async () => {
  const lin = M.defaultImixBlock(1);
  lin.equipment.itrm = { ...M.defaultEquipment("itrm"), gainDb: -6 };
  const sep = await render(allOn(lin));
  const bus = await render(allOn({ ...lin, bus: true }));
  assert.ok(energy(sep.f32) > 0, "the song sounds");
  let worst = 0;
  for (let i = 0; i < sep.f32.length; i++) worst = Math.max(worst, Math.abs(sep.f32[i] - bus.f32[i]));
  assert.ok(worst < 1e-5, `a gain commutes with the sum (${worst})`);
  const comp = M.defaultImixBlock(1);
  comp.equipment.comp = M.defaultEquipment("comp");
  comp.equipment.comp.bands[0].threshDb = -40;
  comp.equipment.comp.bands[0].ratio = 10;
  const a = await render(allOn(comp));
  const c = await render(allOn({ ...comp, bus: true }));
  let diff = 0;
  for (let i = 0; i < a.f32.length; i++) diff = Math.max(diff, Math.abs(a.f32[i] - c.f32[i]));
  assert.ok(diff > 1e-3, `one compressor over the sum is not one per instrument (${diff})`);
  const d = await render(allOn({ ...comp, bus: true }));
  assert.ok(same(c.f32, d.f32), "deterministic");
});

test("a bus-mode block with one instrument on it is bit-for-bit its separate self", async () => {
  const b = M.defaultImixBlock(1);
  b.equipment.comp = M.defaultEquipment("comp");
  b.equipment.verb = M.defaultEquipment("verb");
  // The first instrument heard.
  const probe = new TaudEngine();
  loadIntoEngine(probe, parseTaud(await readFile(DEMO)), 0);
  probe.setCuePosition(0, 0);
  probe.play(0);
  const dev = new Uint8Array(TRACKER_CHUNK * 2);
  let slot = 0;
  for (let i = 0; i < 2000 && slot === 0; i++) {
    probe.renderChunk(0, dev);
    const v = probe.playheads[0].trackerState.voices.find((x) => x.active);
    if (v) slot = (v.displayInst || v.instrumentId) & 0x3ff;
  }
  const one = (block) => (eng) => {
    eng.setImix([block]);
    eng.instruments[slot].imixId = block.id;
    eng.imixGen++;
  };
  const plain = await render(null);
  const sep = await render(one(b));
  assert.ok(!same(plain.f32, sep.f32), "the instrument plays through its chain");
  const bus = await render(one({ ...b, bus: true }));
  assert.ok(same(sep.f32, bus.f32));
  assert.ok(same(sep.u8, bus.u8));
});

test("the Mixing tab's tap on any instrument of a shared bus meters that bus", async () => {
  const { fillSnapshotInto } = await import("../../core/worklet/engine-commands.js");
  const P = await import("../../core/worklet/protocol.js");
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(await readFile(DEMO)), 0);
  const b = M.defaultImixBlock(1);
  b.bus = true;
  b.equipment.itrm = M.defaultEquipment("itrm");
  allOn(b)(eng);
  eng.setCuePosition(0, 0);
  eng.play(0);
  const dev = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < 200; i++) eng.renderChunk(0, dev);
  // The last instrument on the block: never the bus's own first slot.
  eng.setImixMeter(0, 63);
  for (let i = 0; i < 40; i++) eng.renderChunk(0, dev);
  const f = new Float32Array(P.SNAP_FLOATS);
  fillSnapshotInto(eng, 0, f);
  assert.equal(f[P.SNAP_IM_BASE + P.SNAP_IM_SLOT], 63);
  assert.ok(f[P.SNAP_IM_BASE + P.SNAP_IM_FRAMES] > 0, "the shared bus ran and was metered");
});

// ── the chains' names ───────────────────────────────────────────────────────

test("IMcn names chains by id, falls back to nothing, and loses a name with its chain", async () => {
  const doc = new Document(parseTaud(await readFile(DEMO)));
  const undo = new UndoStack(doc, () => {});
  const [a, b] = doc.selectableInstrumentSlots();
  const blk = (id) => { const x = M.defaultImixBlock(id); x.equipment.itrm = M.defaultEquipment("itrm"); return x; };
  undo.apply(compositeOp([
    setImixOp(doc.imixPayloadWith(1, blk(1))), setInstFieldOp(a, "imixId", 1),
  ]));
  undo.apply(compositeOp([
    setImixOp(doc.imixPayloadWith(2, blk(2))), setInstFieldOp(b, "imixId", 2),
  ]));
  assert.equal(doc.imixName(1), "");
  undo.apply(setSectionOp(IMCN_FOURCC, doc.buildImixNames(2, "Drums")));
  const sec = () => doc.projSections.find((s) => s.fourcc === IMCN_FOURCC)?.payload ?? null;
  assert.deepEqual([...sec()], [0x1e, 0x1e, ...new TextEncoder().encode("Drums")], "entry n names block n");
  assert.equal(doc.imixName(2), "Drums");
  assert.equal(doc.imixName(0), "", "id 0 is no chain");
  undo.apply(setSectionOp(IMCN_FOURCC, doc.buildImixNames(1, "Lead")));
  assert.equal(doc.imixName(1), "Lead");
  // Unnaming the last name drops the section.
  undo.apply(setSectionOp(IMCN_FOURCC, doc.buildImixNames(2, "")));
  assert.equal(doc.imixName(2), "");
  undo.apply(setSectionOp(IMCN_FOURCC, doc.buildImixNames(1, "")));
  assert.equal(sec(), null);
  undo.undo(); undo.undo();
  assert.equal(doc.imixName(2), "Drums");
  // Round trip, and a retired chain takes its name with it.
  const again = new Document(parseTaud(doc.toBytes()));
  assert.equal(again.imixName(1), "Lead");
  assert.equal(again.imixName(2), "Drums");
  undo.apply(setInstFieldOp(b, "imixId", 0));
  assert.equal(doc.imixName(2), "Drums", "the session keeps it, as it keeps the block");
  const saved = new Document(parseTaud(doc.toBytes()));
  assert.equal(saved.imixName(2), "");
  assert.equal(saved.imixName(1), "Lead");
  undo.apply(setInstFieldOp(a, "imixId", 0));
  assert.ok(!parseTaud(doc.toBytes()).projSections.some((s) => s.fourcc === IMCN_FOURCC), "no chain left, no names");
});

test("a bank import brings a chain's name to its fresh id", async () => {
  const src = new Document(parseTaud(await readFile(DEMO)));
  const dest = new Document(parseTaud(await readFile(DEMO)));
  const su = new UndoStack(src, () => {});
  const [a] = src.selectableInstrumentSlots();
  const blk = M.defaultImixBlock(1); blk.equipment.itrm = M.defaultEquipment("itrm");
  su.apply(compositeOp([setImixOp(src.imixPayloadWith(1, blk)), setInstFieldOp(a, "imixId", 1)]));
  su.apply(setSectionOp(IMCN_FOURCC, src.buildImixNames(1, "Pads")));
  const du = new UndoStack(dest, () => {});
  du.apply(setImixOp(dest.imixPayloadWith(1, blk)));
  du.apply(setSectionOp(IMCN_FOURCC, dest.buildImixNames(1, "Mine")));
  src._rebuildInstRegion();
  const plan = planImport(dest, src, [a]);
  assert.ok(!plan.error, plan.error);
  applyPlan(dest, plan);
  assert.equal(dest.imixName(2), "Pads");
  assert.equal(dest.imixName(1), "Mine");
});

// ── surround width: the width on an ambisonic scene ─────────────────────────

test("the mastering width is surround width on an ambisonic bus: every channel but W scaled", async () => {
  const { MasterChain, defaultMastering } = await import("../../core/engine/mastering.js");
  const p = { ...defaultMastering(), on: true, widthOn: true, width: 0.5 };
  const N = 64, nch = 4;
  const sig = (c, n) => Math.sin(0.03 * n * (c + 1) + c) * 0.4;
  const fill = () => { const d = new Float64Array(nch * N); for (let c = 0; c < nch; c++) for (let n = 0; n < N; n++) d[c * N + n] = sig(c, n); return d; };
  const amb = fill();
  new MasterChain(p, FS, nch, true).processPlanar(amb, N, N);
  for (let n = 0; n < N; n++) {
    assert.equal(amb[n], sig(0, n), "W untouched");
    for (let c = 1; c < nch; c++) assert.equal(amb[c * N + n], sig(c, n) * 0.5);
  }
  const spk = fill();
  new MasterChain(p, FS, nch, false).processPlanar(spk, N, N);
  assert.ok(same(spk, fill()), "a speaker layout keeps skipping it");
  // …and it IS the stereo stage, seen through the coincident pair W ± Y.
  const scene = fill();
  const L = new Float64Array(N), R = new Float64Array(N);
  for (let n = 0; n < N; n++) { L[n] = 0.5 * (scene[n] + scene[N + n]); R[n] = 0.5 * (scene[n] - scene[N + n]); }
  new MasterChain(p, FS, 2).process(L, R, N);
  new MasterChain(p, FS, nch, true).processPlanar(scene, N, N);
  for (let n = 0; n < N; n++) {
    assert.ok(Math.abs(0.5 * (scene[n] + scene[N + n]) - L[n]) < 1e-15);
    assert.ok(Math.abs(0.5 * (scene[n] - scene[N + n]) - R[n]) < 1e-15);
  }
});

test("the mix tool's width is surround width on an ambisonic bus, and skipped on speakers", () => {
  const b = M.defaultImixBlock(1);
  b.equipment.mxtl = { ...M.defaultEquipment("mxtl"), width: 1.5 };
  const nch = 4, N = 32;
  const run = (ambisonic) => {
    const ch = new M.InstrumentChain(b, FS, nch, false, ambisonic);
    const d = new Float64Array(nch * N);
    for (let c = 0; c < nch; c++) for (let n = 0; n < N; n++) d[c * N + n] = 0.25 * (c + 1);
    ch.process(d, N, 0, N, 125, true);
    return d;
  };
  const amb = run(true);
  assert.equal(amb[5], 0.25, "W untouched");
  assert.equal(amb[N + 5], 0.5 * 1.5);
  assert.equal(amb[3 * N + 5], 1 * 1.5);
  const spk = run(false);
  assert.equal(spk[3 * N + 5], 1, "a speaker layout leaves it");
});
