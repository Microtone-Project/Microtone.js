// Item 261 — the mixing chain's transient shaper (`tsh1`): its codec and
// validation, its behaviour against the engine specification's own formulas,
// what it does to a note, the multiband split it shares with the compressor,
// the meter and display readings, and its TML spelling.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as M from "../../core/engine/imix.js";
import { parseImixSection, buildImixBlock, buildImixSection } from "../../core/format/imix-section.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { interpret } from "../../src/motif/build.js";
import { MotifError } from "../../src/motif/lexer.js";

const FS = 48000;
const DEMO = new URL("../../assets/demo_projects/Huygens_clock.taud", import.meta.url).pathname;

const band = (o = {}) => ({ ...M.defaultTshBand(), ...o });
const shaper = (bands, crossovers = M.defaultCrossovers(bands.length), dry = 0) =>
  ({ ...M.defaultEquipment(M.IMX_TSH1), bands, crossovers, dry });

/** Run blocks of one piece over a stereo signal `sig(n) → [l, r]`; returns
 *  the two channels. */
function run(equipment, sig, frames, chunk = 128) {
  const block = { ...M.defaultImixBlock(1), equipment };
  const ch = new M.InstrumentChain(block, FS, 2, true);
  const L = new Float64Array(frames), R = new Float64Array(frames);
  const buf = new Float64Array(2 * 512);
  for (let s = 0; s < frames; s += chunk) {
    const n1 = Math.min(chunk, frames - s);
    for (let n = 0; n < n1; n++) { const [l, r] = sig(s + n); buf[n] = l; buf[512 + n] = r; }
    ch.process(buf, 512, 0, n1, 125, true);
    for (let n = 0; n < n1; n++) { L[s + n] = buf[n]; R[s + n] = buf[512 + n]; }
  }
  return { L, R, chain: ch };
}

/** A plucked note: silence, then an instant onset decaying over 150 ms. */
const pluck = (a = 0.5, hz = 220, at = 2400) => (n) => {
  if (n < at) return [0, 0];
  const t = (n - at) / FS;
  const v = a * Math.exp(-t / 0.15) * Math.sin(2 * Math.PI * hz * t);
  return [v, -0.5 * v];
};
const rmsDb = (x, from, to) => {
  let s = 0;
  for (let n = from; n < to; n++) s += x[n] * x[n];
  return 10 * Math.log10(s / (to - from) + 1e-300);
};

// ── the codec ───────────────────────────────────────────────────────────────

test("a three-band transient shaper round-trips through the section, binary32-stable", () => {
  const b = M.defaultImixBlock(4);
  b.equipment.tsh1 = shaper([
    band({ attackDb: 6.3, sustainDb: -2.1, attackMs: 12.5 }),
    band({ on: false, releaseMs: 900 }),
    band({ attackDb: -7, outDb: 1.5 }),
  ], [180, 2600], 77);
  const bytes = buildImixBlock(b);
  // header 4 + list 4 + FourCC 4 + size 4, then 8 + 2 crossovers + 3 bands of 24
  assert.equal(String.fromCharCode(...bytes.subarray(4, 8)), "tsh1");
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), "tsh1");
  assert.equal(bytes[12] | (bytes[13] << 8), 8 + 8 + 72);
  assert.equal(bytes[16 + 1], 77, "the dry amount: a transient shaper has a wet/dry");
  assert.equal(bytes[16 + 4], 3, "band count");
  const { blocks, problems } = parseImixSection(bytes);
  assert.deepEqual(problems, []);
  const back = blocks.get(4);
  assert.ok(M.imixBlockEqual(back, b));
  assert.deepEqual(buildImixSection([back]), buildImixSection([b]));
  assert.equal(back.equipment.tsh1.bands[1].on, false);
  assert.equal(back.equipment.tsh1.bands[0].attackDb, Math.fround(6.3));
});

test("a transient shaper of no bands, of seven, crossovers out of order or the wrong size is a contradiction", () => {
  const make = (patch) => {
    const b = M.defaultImixBlock(1);
    b.equipment.tsh1 = shaper([band(), band(), band()], [300, 3000]);
    const bytes = buildImixBlock(b);
    patch(bytes, new DataView(bytes.buffer));
    return parseImixSection(bytes).problems[0]?.kind;
  };
  assert.equal(make(() => {}), undefined, "the unpatched block is valid");
  assert.equal(make((b) => { b[16 + 4] = 0; }), "invalid", "0 bands");
  assert.equal(make((b) => { b[16 + 4] = 7; }), "invalid", "7 bands");
  assert.equal(make((b) => { b[16 + 4] = 2; }), "invalid", "a band count the payload size disagrees with");
  assert.equal(make((b, dv) => dv.setFloat32(16 + 12, 100, true)), "invalid", "crossovers not ascending");
  // Out of range is clamped, not refused.
  const b = M.defaultImixBlock(2);
  b.equipment.tsh1 = shaper([band()]);
  const bytes = buildImixBlock(b);
  new DataView(bytes.buffer).setFloat32(16 + 8 + 4, 99, true);
  const { blocks, problems } = parseImixSection(bytes);
  assert.deepEqual(problems, []);
  assert.equal(blocks.get(2).equipment.tsh1.bands[0].attackDb, 24);
});

test("tsh1 runs between the dynamic EQ and the compressor in both pipelines, and is not yet tsh2", () => {
  for (const p of M.IMX_PIPELINES) {
    assert.equal(p.indexOf(M.IMX_TSH1), p.indexOf(M.IMX_DEQ1) + 1);
    assert.equal(p.indexOf(M.IMX_COMP), p.indexOf(M.IMX_TSH1) + 1);
    assert.ok(!p.includes("tsh2"), "tsh2 is reserved, not defined");
  }
  assert.ok(M.IMX_WET_APPLICABLE.has(M.IMX_TSH1));
  // A block holding a tsh2 keeps it as unknown equipment.
  const b = { ...M.defaultImixBlock(3), unknown: [{ fourcc: "tsh2", bytes: Uint8Array.of(0, 0, 0, 0) }] };
  const r = parseImixSection(buildImixBlock(b));
  assert.deepEqual(r.problems, [{ kind: "unknown", id: 3, detail: ["tsh2"] }]);
});

test("adding or taking away a band leaves every other crossover where it was, for the shaper and the compressor", () => {
  for (const [id, makeBand] of [[M.IMX_TSH1, M.defaultTshBand], [M.IMX_COMP, M.defaultCompBand]]) {
    const piece = (bands, crossovers) => M.normaliseEquipment(id, { ...M.defaultEquipment(id), bands, crossovers });
    const marked = (i) => ({ ...makeBand(), on: i % 2 === 0, [id === M.IMX_COMP ? "threshDb" : "attackDb"]: -i });
    // Two bands at a hand-set 333 Hz → five: 333 Hz stays, the new ones go above it.
    const e = piece([marked(0), marked(1)], [333]);
    M.resizeSplit(e, 5, makeBand);
    const n = M.normaliseEquipment(id, e);
    assert.equal(n.bands.length, 5, id);
    assert.equal(n.crossovers[0], Math.fround(333), `${id}: the crossover set by hand stays`);
    for (let k = 1; k < 4; k++) assert.ok(n.crossovers[k] >= n.crossovers[k - 1] * M.IMX_XOVER_GAP, `${id}: ascending, a gap apart`);
    assert.deepEqual(n.bands.slice(0, 2), piece([marked(0), marked(1)], [333]).bands, `${id}: the bands it had keep their settings`);
    // …and back to three keeps the first two crossovers as they are.
    const kept = n.crossovers.slice(0, 2);
    M.resizeSplit(n, 3, makeBand);
    assert.deepEqual(M.normaliseEquipment(id, n).crossovers, kept, `${id}: fewer bands drop only the top crossovers`);
    // No room above the last crossover: the widest band is split instead, and
    // every band above the split keeps its range and its settings.
    const full = piece([marked(0), marked(1), marked(2)], [100, 19800]);
    M.resizeSplit(full, 4, makeBand);
    const f = M.normaliseEquipment(id, full);
    assert.deepEqual([f.crossovers[0], f.crossovers[2]], [Math.fround(100), Math.fround(19800)], `${id}: 100 Hz and 19.8 kHz stay`);
    assert.ok(f.crossovers[1] > 100 && f.crossovers[1] < 19800, `${id}: the new crossover splits the band between them`);
    assert.deepEqual([f.bands[0], f.bands[1], f.bands[3]], [marked(0), marked(1), marked(2)].map((b) => piece([b], []).bands[0]),
      `${id}: the split band keeps its settings below the new crossover, the top band its own`);
    // From one band there is nothing to keep: the usual spread.
    const one = piece([makeBand()], []);
    M.resizeSplit(one, 3, makeBand);
    assert.deepEqual(M.normaliseEquipment(id, one).crossovers, M.defaultCrossovers(3).map(Math.fround));
  }
});

// ── the engine against its specification ────────────────────────────────────

/**
 * TAUD_ENGINE_SPEC.md §12.4 `tsh1`, one band, written as plainly as it reads:
 * the window's peak by brute force over the last W levels.
 */
function reference(b, L, R) {
  const W = Math.max(1, Math.round(M.IMX_TSH_WINDOW_SEC * FS));
  const onePole = (ms) => 1 - Math.exp(-1 / ((ms / 1000) * FS));
  const a = onePole(b.attackMs), r = onePole(b.releaseMs), sm = onePole(1);
  const lvl = new Float64Array(L.length);
  const oL = new Float64Array(L.length), oR = new Float64Array(L.length);
  let S = 0, Lv = 0, e = 0;
  for (let n = 0; n < L.length; n++) {
    lvl[n] = Math.max(Math.abs(L[n]), Math.abs(R[n]));
    let P = 0;
    for (let k = Math.max(0, n - W + 1); k <= n; k++) if (lvl[k] > P) P = lvl[k];
    S = P > S ? S + (P - S) * a : P;
    Lv = P < Lv ? Lv + (P - Lv) * r : P;
    const transient = P > 0 ? 1 - S / P : 0;
    const sustain = Lv > 0 ? 1 - P / Lv : 0;
    e = e + (b.attackDb * transient + b.sustainDb * sustain - e) * sm;
    const g = 10 ** ((e + b.outDb) / 20);
    oL[n] = L[n] * g; oR[n] = R[n] * g;
  }
  return { L: oL, R: oR };
}

test("one band is the specification's formulas to the bit, the window's peak taken by brute force", () => {
  const frames = 24000;
  // Two notes, the second over the first's tail, so the window, both
  // envelopes and the glide all work.
  const sig = (n) => {
    const [a] = pluck(0.5, 220, 2400)(n);
    const [b] = pluck(0.3, 330, 9000)(n);
    return [a + b, 0.6 * a - b];
  };
  const b = M.normaliseEquipment(M.IMX_TSH1, shaper([band({ attackDb: 9, sustainDb: -7, attackMs: 15, releaseMs: 180, outDb: -1.5 })]));
  const got = run({ tsh1: b }, sig, frames);
  const inL = new Float64Array(frames), inR = new Float64Array(frames);
  for (let n = 0; n < frames; n++) [inL[n], inR[n]] = sig(n);
  const want = reference(b.bands[0], inL, inR);
  for (let n = 0; n < frames; n++) {
    if (got.L[n] !== want.L[n] || got.R[n] !== want.R[n]) {
      assert.fail(`sample ${n}: ${got.L[n]}, ${got.R[n]} vs ${want.L[n]}, ${want.R[n]}`);
    }
  }
});

test("attack lifts a note's start, sustain its decay; neither depends on the note's loudness", () => {
  const frames = 30000;
  const at = 2400, start = [at, at + 240], tail = [at + 9600, at + 14400];
  const dry = run({ itrm: M.defaultEquipment(M.IMX_ITRM) }, pluck(), frames).L;
  const atk = run({ tsh1: shaper([band({ attackDb: 12 })]) }, pluck(), frames).L;
  const sus = run({ tsh1: shaper([band({ sustainDb: -12 })]) }, pluck(), frames).L;
  const lift = rmsDb(atk, ...start) - rmsDb(dry, ...start);
  assert.ok(lift > 8 && lift <= 12, `the first 5 ms lifted by ${lift.toFixed(2)} dB`);
  assert.ok(Math.abs(rmsDb(atk, ...tail) - rmsDb(dry, ...tail)) < 0.05, "…and the tail left alone");
  assert.ok(Math.abs(rmsDb(sus, ...start) - rmsDb(dry, ...start)) < 0.05, "a sustain cut leaves the start alone");
  const cut = rmsDb(sus, ...tail) - rmsDb(dry, ...tail);
  assert.ok(cut < -6 && cut >= -12, `…and lowers the tail by ${cut.toFixed(2)} dB`);
  // 20 dB quieter, the same shape: the detector and both envelopes scale.
  const quiet = run({ tsh1: shaper([band({ attackDb: 12, sustainDb: -12 })]) }, pluck(0.05), frames).L;
  const loud = run({ tsh1: shaper([band({ attackDb: 12, sustainDb: -12 })]) }, pluck(0.5), frames).L;
  for (let n = 0; n < frames; n++) {
    assert.ok(Math.abs(quiet[n] * 10 - loud[n]) < 1e-9, `sample ${n}: ${quiet[n] * 10} vs ${loud[n]}`);
  }
});

test("a steady tone passes, down to 20 Hz", () => {
  for (const hz of [20, 55, 440]) {
    const sig = (n) => { const v = 0.5 * Math.sin((2 * Math.PI * hz * n) / FS); return [v, v]; };
    const { L } = run({ tsh1: shaper([band({ attackDb: 24, sustainDb: -24 })]) }, sig, FS * 2);
    let worst = 0;
    for (let n = FS; n < 2 * FS; n++) worst = Math.max(worst, Math.abs(L[n] - sig(n)[0]));
    // Only where the samples fall on the tone's peaks moves its level, by a
    // few parts in a million.
    assert.ok(worst < 2e-5, `${hz} Hz: ${worst}`);
  }
});

test("its bands are the compressor's split: at 0 dB a multiband shaper is the compressor with its bands off, to the bit", () => {
  const xs = [150, 1200, 7000];
  const sig = (n) => { const v = 0.4 * Math.sin(n * 0.031) + 0.2 * Math.sin(n * 0.41) * ((n >> 10) & 1); return [v, -0.7 * v]; };
  const comp = { ...M.defaultEquipment(M.IMX_COMP), bands: xs.concat(0).map(() => ({ ...M.defaultCompBand(), on: false })), crossovers: xs };
  const a = run({ comp }, sig, 20000);
  const b = run({ tsh1: shaper([band(), band(), band(), band()], xs) }, sig, 20000);
  for (let n = 0; n < 20000; n++) {
    if (a.L[n] !== b.L[n] || a.R[n] !== b.R[n]) assert.fail(`sample ${n}`);
  }
});

test("a multiband shaper with its wet/dry does not depend on how the bus is cut into spans", () => {
  const sig = (n) => {
    const [a] = pluck(0.5, 110, 1000)(n % 7000);
    const [b] = pluck(0.4, 2000, 3000)(n);
    return [a + b, a - b];
  };
  const eq = { tsh1: shaper([band({ attackDb: 8, sustainDb: -6 }), band({ attackDb: -4, sustainDb: 5, attackMs: 3 }), band({ sustainDb: 9, releaseMs: 1500 })], [300, 2500], 90) };
  const a = run(eq, sig, 30000, 128), b = run(eq, sig, 30000, 37), c = run(eq, sig, 30000, 500);
  for (let n = 0; n < 30000; n++) {
    if (a.L[n] !== b.L[n] || a.L[n] !== c.L[n] || a.R[n] !== b.R[n] || a.R[n] !== c.R[n]) assert.fail(`sample ${n}`);
  }
});

test("a bypassed or all-off shaper is not processed; an inserted one at 0 dB is the identity", () => {
  const sig = pluck();
  const dry = run({ itrm: M.defaultEquipment(M.IMX_ITRM) }, sig, 10000);
  for (const tsh1 of [shaper([band()]), { ...shaper([band({ attackDb: 12 })]), bypass: true }, shaper([band({ on: false, attackDb: 12 })])]) {
    const got = run({ itrm: M.defaultEquipment(M.IMX_ITRM), tsh1 }, sig, 10000);
    assert.deepEqual([...got.L], [...dry.L]);
    assert.deepEqual([...got.R], [...dry.R]);
  }
});

// ── what the editor reads ───────────────────────────────────────────────────

test("the meter reads each band's signed gain, and the display draws the shaper at it", () => {
  const { chain } = run({ tsh1: shaper([band({ attackDb: 12 }), band({ sustainDb: -12 })], [1000]) }, pluck(0.5, 220, 64), 512);
  const r = chain.readGr(M.makeImixGrReadout());
  assert.ok(r.tsh1[0] > 6, `band 1 lifts the onset (${r.tsh1[0]})`);
  assert.equal(r.tsh1[2], 0, "a band the shaper does not have reads nothing");
  const e = shaper([band({ outDb: 2 }), band({ outDb: 2 }), band({ outDb: 2 })], M.defaultCrossovers(3));
  const view = new M.InstrumentChain({ ...M.defaultImixBlock(1), equipment: { tsh1: e } });
  for (const f of [30, 400, 3000, 15000]) assert.ok(Math.abs(view.stageResponseDb("tsh1", f) - 2) < 1e-6, `at rest: its output, ${f} Hz`);
  view.showGains("tsh1", new Float64Array([0, 0, 9, 0, 0, 0]));
  assert.ok(view.stageResponseDb("tsh1", 15000) > 10, "the top band's lift shows above its crossover");
  assert.ok(Math.abs(view.stageResponseDb("tsh1", 30) - 2) < 0.1, "…and not at the bottom");
});

test("the snapshot carries the shaper's band gains and its input ring", async () => {
  const { fillSnapshotInto } = await import("../../core/worklet/engine-commands.js");
  const P = await import("../../core/worklet/protocol.js");
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(await readFile(DEMO)), 0);
  const b = M.defaultImixBlock(1);
  b.equipment.tsh1 = shaper([band({ attackDb: 12, sustainDb: 6 })]);
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
  eng.setImixMeter(0, slot);
  for (let i = 0; i < 40; i++) eng.renderChunk(0, dev);
  const f = new Float32Array(P.SNAP_FLOATS);
  fillSnapshotInto(eng, 0, f);
  assert.ok(f[P.SNAP_IM_BASE + P.SNAP_IM_FRAMES] > 0);
  assert.ok(f[P.SNAP_IM_BASE + P.SNAP_IM_TSH1] > 0, `the band's gain (${f[P.SNAP_IM_BASE + P.SNAP_IM_TSH1]} dB)`);
  const o = P.SNAP_IM_BASE + P.SNAP_IM_STAGE_RINGS + M.IMX_TAP_STAGES.indexOf(M.IMX_TSH1) * P.SNAP_IM_RING_FRAMES;
  let energy = 0;
  for (let i = 0; i < P.SNAP_IM_RING_FRAMES; i++) energy += f[o + i] ** 2;
  assert.ok(energy > 0, "the shaper's input is rung");
  assert.equal(P.SNAP_FLOATS, P.SNAP_IM_BASE + P.SNAP_IM_TSH1 + M.IMX_TSH_MAX_BANDS, "the gains end the snapshot");
});

// ── TML ─────────────────────────────────────────────────────────────────────

const chainOfInst = (src) => {
  const score = interpret(`tml 2\nsong { bars: 1 }\n${src}`);
  return score.instruments[0].chain;
};

test("TML: transient_shaper_1 takes one band's fields or a list of bands, in the tab's words", () => {
  const one = chainOfInst(`instrument S { wave: "sine", chain: { transient_shaper_1: { attack: 6, sustain: -3, attack_time: 12, sustain_time: 400, output: -1, mix: 0.75 } } }`);
  const t1 = one.equipment.tsh1;
  assert.equal(t1.bands.length, 1);
  assert.deepEqual(
    [t1.bands[0].attackDb, t1.bands[0].sustainDb, t1.bands[0].attackMs, t1.bands[0].releaseMs, t1.bands[0].outDb, t1.dry, t1.bypass],
    [6, -3, 12, 400, -1, Math.round(255 * 0.25), false]);
  const many = chainOfInst(`instrument S { wave: "sine", chain: { transient_shaper_1: { crossovers: [250, 4000], bands: [{ attack: 9 }, { on: false }, { sustain: 4 }] } } }`);
  const t3 = many.equipment.tsh1;
  assert.deepEqual(t3.crossovers, [250, 4000]);
  assert.deepEqual(t3.bands.map((b) => [b.on, b.attackDb, b.sustainDb]), [[true, 9, 0], [false, 0, 0], [true, 0, 4]]);
  const err = (x) => {
    try { chainOfInst(`instrument S { wave: "sine", chain: { transient_shaper_1: { ${x} } } }`); } catch (e) { if (e instanceof MotifError) return e.message; throw e; }
    assert.fail("expected a MotifError");
  };
  assert.match(err(`attack: 30`), /attack must be -24…24, not 30/);
  assert.match(err(`sustain_time: 5`), /sustain_time must be 10…3000, not 5/);
  assert.match(err(`attack: 3, bands: [{}]`), /with bands, give attack to each band/);
  assert.match(err(`bands: [{}, {}], crossovers: [100, 200]`), /2 bands take 1 crossover, not 2/);
  assert.match(err(`threshold: -20`), /no option "threshold"/);
});
