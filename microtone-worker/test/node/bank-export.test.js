// .tsii export (item 229): planBankExport takes chosen instruments out of a
// project as a bank, slot numbers kept, and the file it writes reads back as
// exactly those instruments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";
import { SAMPLEBIN_SIZE, TAUD_KIND_SAMPLEINST, TAUD_KIND_MASK } from "../../core/format/taud-const.js";
import { IMIX_FOURCC } from "../../core/format/imix-section.js";
import * as M from "../../core/engine/imix.js";
import { Document, BANK_SECTIONS, sampleSpans } from "../../src/doc/document.js";
import { planBankExport, bankExportClosure, bankExportSize } from "../../src/doc/cleanup.js";
import { UndoStack } from "../../src/doc/undo.js";
import { setImixOp, setInstFieldOp, compositeOp } from "../../src/doc/ops.js";

const demo = (name) => fileURLToPath(new URL(`../../assets/demo_projects/${name}.taud`, import.meta.url));
const load = (name) => new Document(parseTaud(readFileSync(demo(name))));

/** Export `slots` of `doc` and read the written file back. */
function exportAndRead(doc, slots, opts) {
  const plan = planBankExport(doc, slots, opts);
  const bytes = new Document(plan).toBytes();
  return { plan, bytes, parsed: parseTaud(bytes), back: new Document(parseTaud(bytes)) };
}

/** Every pool span the doc's census claims, all channels. */
const censusSpans = (doc) => doc.sampleList().flatMap((e) => sampleSpans(e).map((sp) => ({ ...sp, name: e.name })));

test("the whole bank goes out as a .tsii: no songs, bank sections only, every instrument verbatim", () => {
  const doc = load("16uba_baion");
  const { parsed, back } = exportAndRead(doc, doc.selectableInstrumentSlots());
  assert.equal(parsed.kind, "tsii");
  assert.equal(parsed.songs.length, 0);
  assert.equal(parsed.fmtVer, 2);
  assert.ok(parsed.projSections.every((s) => BANK_SECTIONS.includes(s.fourcc)),
    parsed.projSections.map((s) => s.fourcc).join(","));
  assert.deepEqual(back.usedInstrumentSlots(), doc.usedInstrumentSlots());
  for (const s of doc.usedInstrumentSlots()) {
    assert.deepEqual(back.instRecordBytes(s), doc.instRecordBytes(s), `record $${s.toString(16)}`);
    assert.equal(back.instrumentName(s), doc.instrumentName(s));
  }
  assert.deepEqual(back.ixmp.map((e) => [e.instId, [...e.blob]]), doc.ixmp.map((e) => [e.instId, [...e.blob]]));
  assert.deepEqual(back.sampleList().map((e) => [e.ptr, e.len, e.name]),
    doc.sampleList().map((e) => [e.ptr, e.len, e.name]));
  for (const sp of censusSpans(doc)) {
    assert.deepEqual(back.sampleBin.subarray(sp.ptr, sp.ptr + sp.len), doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len));
  }
  // The version byte says .tsii.
  const bytes = new Document(planBankExport(doc, doc.selectableInstrumentSlots())).toBytes();
  assert.equal(bytes[8] & TAUD_KIND_MASK, TAUD_KIND_SAMPLEINST);
});

test("a chosen metainstrument brings its layers; everything else is gone, slots and names kept", () => {
  const doc = load("16uba_baion");
  const meta = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isMeta);
  const plain = doc.selectableInstrumentSlots().find((s) => !doc.instruments[s].isMeta && s > meta);
  const { plan, back } = exportAndRead(doc, [meta, plain]);
  const keep = bankExportClosure(doc, [meta, plain]);
  for (const k of doc.instruments[meta].sourceSlots) assert.ok(keep.has(k), `layer $${k.toString(16)}`);
  assert.equal(plan.instruments, keep.size);
  // The dialog's tally counts what the export writes.
  assert.deepEqual(bankExportSize(doc, [meta, plain]), { instruments: plan.instruments, sampleBytes: plan.sampleBytes });
  assert.deepEqual(back.usedInstrumentSlots(), [...keep].sort((a, b) => a - b));
  for (const s of keep) {
    assert.deepEqual(back.instRecordBytes(s), doc.instRecordBytes(s));
    assert.equal(back.instrumentName(s), doc.instrumentName(s));
  }
  assert.ok(back.ixmp.every((e) => keep.has(e.instId & 0x3ff)));
  assert.deepEqual(back.ixmp.map((e) => e.instId),
    doc.ixmp.filter((e) => keep.has(e.instId & 0x3ff)).map((e) => e.instId));
  // The samples the kept instruments play, with their names and bytes; the
  // pool is zero everywhere else.
  const names = new Map(doc.sampleList().map((e) => [`${e.ptr}:${e.len}`, e.name]));
  const spans = censusSpans(back);
  assert.ok(spans.length > 0 && spans.length < censusSpans(doc).length);
  const claimed = new Uint8Array(SAMPLEBIN_SIZE);
  for (const sp of spans) {
    if (sp.chan === 0) assert.equal(sp.name, names.get(`${sp.ptr}:${sp.len}`));
    assert.deepEqual(back.sampleBin.subarray(sp.ptr, sp.ptr + sp.len), doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len));
    claimed.fill(1, sp.ptr, sp.ptr + sp.len);
  }
  let stray = 0;
  for (let i = 0; i < SAMPLEBIN_SIZE; i++) if (!claimed[i] && back.sampleBin[i] !== 0) stray++;
  assert.equal(stray, 0);
  // The project itself is untouched.
  assert.equal(doc.usedInstrumentSlots().length, load("16uba_baion").usedInstrumentSlots().length);
});

test("a formant instrument keeps the sample it sings through", () => {
  const doc = load("Daisy_bell");
  const f = doc.selectableInstrumentSlots().find((s) => doc.instruments[s].isFormant);
  const { back } = exportAndRead(doc, [f]);
  const keep = bankExportClosure(doc, [f]);
  for (const k of doc.instruments[f].sourceSlots) assert.ok(keep.has(k));
  for (const s of keep) assert.deepEqual(back.instRecordBytes(s), doc.instRecordBytes(s));
  const users = (d) => d.sampleList().filter((e) => e.users.includes(f)).map((e) => [e.ptr, e.len, e.name]);
  assert.ok(users(doc).length > 0);
  assert.deepEqual(users(back), users(doc));
  for (const [ptr, len] of users(doc)) {
    assert.deepEqual(back.sampleBin.subarray(ptr, ptr + len), doc.sampleBin.subarray(ptr, ptr + len));
  }
});

test("pool regions travel with the bank unless left out", () => {
  const doc = load("Temjin_speaki");
  const [r] = doc.sampleRegions();
  const slot = doc.selectableInstrumentSlots()[0];
  const withR = exportAndRead(doc, [slot]);
  assert.deepEqual(withR.back.sampleRegions(), doc.sampleRegions());
  assert.deepEqual(withR.back.sampleBin.subarray(r.ptr, r.ptr + r.len), doc.sampleBin.subarray(r.ptr, r.ptr + r.len));
  const without = exportAndRead(doc, [slot], { regions: false });
  assert.equal(without.plan.regions, 0);
  assert.ok(!without.parsed.projSections.some((s) => s.fourcc === "SRgn"));
  assert.deepEqual(without.back.sampleRegions(), []);
});

test("unsaved edits are in the export, and a chain only an excluded instrument used is retired", () => {
  const doc = load("Huygens_clock");
  const undo = new UndoStack(doc, () => {});
  const [a, b] = doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta);
  const block = (id) => { const x = M.defaultImixBlock(id); x.enabled = true; return x; };
  undo.apply(compositeOp([setImixOp(doc.imixPayloadWith(1, block(1))), setInstFieldOp(a, "imixId", 1)]));
  undo.apply(compositeOp([setImixOp(doc.imixPayloadWith(2, block(2))), setInstFieldOp(b, "imixId", 2)]));
  undo.apply(setInstFieldOp(a, "volumeSwing", 17));
  const { parsed, back } = exportAndRead(doc, [a]);
  assert.equal(back.instruments[a].volumeSwing, 17);
  assert.equal(back.instruments[a].imixId, 1);
  assert.deepEqual(parsed.imix.map((x) => x.id), [1]);
  assert.ok(parsed.projSections.some((s) => s.fourcc === IMIX_FOURCC));
});

test("a project without a bank has nothing to export", () => {
  const doc = load("16uba_baion");
  doc.sampleInstImage = null;
  assert.equal(planBankExport(doc, [1]), null);
});
