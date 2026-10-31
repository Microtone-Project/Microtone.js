// Item 261 — the mixing chain's downward expander, which shuts like a gate
// below its floor (`expd`): its codec and validation, its behaviour against
// the engine specification's own formulas, what it does to a sound between the
// floor and the threshold and under the floor, the meter and the snapshot, and
// its TML spelling.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as M from "../../core/engine/imix.js";
import { Biquad } from "../../core/engine/mastering.js";
import { parseImixSection, buildImixBlock, buildImixSection } from "../../core/format/imix-section.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { interpret } from "../../src/motif/build.js";
import { MotifError } from "../../src/motif/lexer.js";

const FS = 48000;
const DEMO = new URL("../../assets/demo_projects/Huygens_clock.taud", import.meta.url).pathname;

const expander = (o = {}) => M.normaliseEquipment(M.IMX_EXPD, { ...M.defaultEquipment(M.IMX_EXPD), ...o });

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

const db = (x) => 10 ** (x / 20);
const tone = (hz, level) => (n) => { const v = db(level) * Math.sin((2 * Math.PI * hz * n) / FS); return [v, v]; };
/** Silence, a loud plucked note decaying over 120 ms, then quiet hiss-like hum. */
const pluck = (n) => {
  const t = n / FS;
  const note = n < 2400 ? 0 : 0.6 * Math.exp(-(n - 2400) / FS / 0.12) * Math.sin(2 * Math.PI * 220 * t);
  const hum = 0.003 * Math.sin(2 * Math.PI * 1234 * t);
  return [note + hum, 0.8 * note - hum];
};
const rmsDb = (x, from, to) => {
  let s = 0;
  for (let n = from; n < to; n++) s += x[n] * x[n];
  return 10 * Math.log10(s / (to - from) + 1e-300);
};

// ── the codec ───────────────────────────────────────────────────────────────

test("an expander round-trips through the section: 48 bytes, its floor (−∞ included), flags and wet/dry", () => {
  for (const floorDb of [-55.5, -Infinity, -42.5]) {
    const b = M.defaultImixBlock(6);
    b.equipment.expd = expander({ keyFilter: true, detector: 1, threshDb: -42.5, floorDb, hysteresisDb: 3, keyLowCut: 200, dry: 51 });
    const bytes = buildImixBlock(b);
    assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), "expd");
    assert.equal(bytes[12] | (bytes[13] << 8), 48);
    assert.equal(bytes[16 + 1], 51, "dry amount");
    assert.equal(bytes[16 + 4], 1, "flags: key filter");
    assert.equal(bytes[16 + 5], 1, "detector: RMS");
    assert.equal(new DataView(bytes.buffer).getFloat32(16 + 12, true), floorDb, "the floor at +12");
    const { blocks, problems } = parseImixSection(bytes);
    assert.deepEqual(problems, []);
    assert.equal(blocks.get(6).equipment.expd.floorDb, floorDb);
    assert.ok(M.imixBlockEqual(blocks.get(6), b));
    assert.deepEqual(buildImixSection([blocks.get(6)]), buildImixSection([b]));
  }
});

test("a floor above the threshold is a contradiction in a file; the editor's data brings it down to the threshold", () => {
  const b = M.defaultImixBlock(1);
  b.equipment.expd = expander({ threshDb: -30, floorDb: -40 });
  const bytes = buildImixBlock(b);
  new DataView(bytes.buffer).setFloat32(16 + 12, -20, true);
  assert.equal(parseImixSection(bytes).problems[0]?.kind, "invalid");
  assert.equal(expander({ threshDb: -30, floorDb: -20 }).floorDb, -30);
  assert.equal(expander({ threshDb: -30 }).floorDb, -Infinity, "no floor is −∞");
});

test("an undefined detector or a wrong size is a contradiction; a value out of range is clamped", () => {
  const b = M.defaultImixBlock(1);
  b.equipment.expd = expander();
  const bad = buildImixBlock(b);
  bad[16 + 5] = 2;
  assert.equal(parseImixSection(bad).problems[0]?.kind, "invalid");
  const ok = buildImixBlock(b);
  new DataView(ok.buffer).setFloat32(16 + 8, -200, true);
  const r = parseImixSection(ok);
  assert.deepEqual(r.problems, []);
  assert.equal(r.blocks.get(1).equipment.expd.threshDb, -80);
});

test("expd runs right after the input trim in both pipelines", () => {
  for (const p of M.IMX_PIPELINES) {
    assert.equal(p.indexOf(M.IMX_EXPD), 1);
    assert.equal(p[0], M.IMX_ITRM);
  }
  assert.ok(M.IMX_WET_APPLICABLE.has(M.IMX_EXPD));
});

// ── the engine against its specification ────────────────────────────────────

/** TAUD_ENGINE_SPEC.md §12.4 `expd`, written as plainly as it reads, the
 *  window's peak by brute force. The chain is idle — untouched, its state at
 *  reset — until its first non-zero sample (§12.4 "Idle"), and silence is
 *  something an expander acts on, so the reference starts there too. */
function reference(e, L, R) {
  const W = Math.max(1, Math.round(M.IMX_EXPD_WINDOW_SEC * FS));
  const onePole = (ms) => 1 - Math.exp(-1 / ((ms / 1000) * FS));
  const a = onePole(e.attackMs), r = onePole(e.releaseMs), rc = onePole(10);
  const H = Math.round((e.holdMs * FS) / 1000);
  const hp = new Biquad(2), lp = new Biquad(2);
  hp.highPass(e.keyLowCut, Math.SQRT1_2, FS);
  lp.lowPass(e.keyHighCut, Math.SQRT1_2, FS);
  const lvl = [];
  const oL = new Float64Array(L.length), oR = new Float64Array(L.length);
  let g = 0, hold = 0, shut = false, ms = 0;
  let first = 0;
  while (first < L.length && L[first] === 0 && R[first] === 0) first++;
  for (let n = first; n < L.length; n++) {
    let k = [L[n], R[n]];
    if (e.keyFilter) k = k.map((x, c) => lp.run(c, hp.run(c, x)));
    let level;
    if (e.detector === 0) {
      lvl[n] = Math.max(Math.abs(k[0]), Math.abs(k[1]));
      level = 0;
      for (let j = Math.max(first, n - W + 1); j <= n; j++) if (lvl[j] > level) level = lvl[j];
    } else {
      ms += ((k[0] * k[0] + k[1] * k[1]) / 2 - ms) * rc;
      level = Math.sqrt(ms);
    }
    const Ld = level > 1e-6 ? 20 * Math.log10(level) : -120;
    if (Ld < e.floorDb) shut = true;
    else if (Ld >= e.floorDb + e.hysteresisDb) shut = false;
    const target = shut ? -e.rangeDb
      : Ld < e.threshDb ? -Math.min(e.rangeDb, (e.threshDb - Ld) * (e.ratio - 1)) : 0;
    if (target >= g) { g = g + (target - g) * a; hold = H; }
    else if (hold > 0) hold--;
    else g = g + (target - g) * r;
    const k2 = 10 ** (g / 20);
    oL[n] = L[n] * k2; oR[n] = R[n] * k2;
  }
  return { L: oL, R: oR };
}

test("the expander and its floor are the specification's formulas to the bit, both detectors, key filter or not", () => {
  const frames = 24000;
  const inL = new Float64Array(frames), inR = new Float64Array(frames);
  for (let n = 0; n < frames; n++) [inL[n], inR[n]] = pluck(n);
  for (const o of [
    { threshDb: -36, ratio: 3, rangeDb: 30, holdMs: 15 },
    { threshDb: -30, floorDb: -30, rangeDb: 40, hysteresisDb: 6, holdMs: 25, releaseMs: 60 },
    { detector: 1, threshDb: -24, floorDb: -40, ratio: 2, keyFilter: true, keyLowCut: 300, keyHighCut: 3000 },
    { detector: 1, threshDb: -40, floorDb: -48, hysteresisDb: 3, ratio: 5, rangeDb: 80, attackMs: 0.1, holdMs: 0, keyFilter: true },
  ]) {
    const e = expander(o);
    const got = run({ expd: e }, pluck, frames);
    const want = reference(e, inL, inR);
    for (let n = 0; n < frames; n++) {
      if (got.L[n] !== want.L[n] || got.R[n] !== want.R[n]) assert.fail(`${JSON.stringify(o)}: sample ${n}`);
    }
  }
});

test("an expander pushes a quiet tone down by its ratio, never past its range, and leaves a loud one exactly alone", () => {
  const settled = (o, level) => {
    const { L } = run({ expd: expander(o) }, tone(440, level), FS);
    return rmsDb(L, FS / 2, FS) - (level - 3.0103);
  };
  const quick = { threshDb: -30, rangeDb: 40, releaseMs: 10 };
  assert.ok(Math.abs(settled({ ...quick, ratio: 2 }, -40) - -10) < 0.05, "10 dB under, 1:2 → 10 dB more");
  assert.ok(Math.abs(settled({ ...quick, ratio: 4 }, -40) - -30) < 0.05, "1:4 → 30 dB more");
  assert.ok(Math.abs(settled({ ...quick, ratio: 4, rangeDb: 12 }, -40) - -12) < 0.05, "…stopped at the range");
  // A tone that starts at its crest is never under the threshold: not a bit changes.
  const crest = (n) => { const v = db(-12) * Math.cos((2 * Math.PI * 440 * n) / FS); return [v, v]; };
  const loud = run({ expd: expander({ threshDb: -30, ratio: 4 }) }, crest, 20000);
  for (let n = 0; n < 20000; n++) assert.equal(loud.L[n], crest(n)[0], `sample ${n}`);
});

test("with its floor at its threshold it is a gate: it shuts the hum after the note, and does not chatter at the floor", () => {
  const { L } = run({ expd: expander({ threshDb: -30, floorDb: -30, rangeDb: 60, holdMs: 20, releaseMs: 30 }) }, pluck, 48000);
  const dry = run({ itrm: M.defaultEquipment(M.IMX_ITRM) }, pluck, 48000).L;
  // (after the gate's 1 ms attack has opened it)
  assert.ok(Math.abs(rmsDb(L, 2400 + 480, 4800) - rmsDb(dry, 2400 + 480, 4800)) < 0.1, "the note passes");
  assert.ok(rmsDb(L, 36000, 48000) < rmsDb(dry, 36000, 48000) - 55, "the hum after it is shut out");
  // A tone hovering at the floor, 2 dB either way: once it has dipped under,
  // 6 dB of hysteresis keeps the gate shut — it would have to climb to −24 dB
  // to reopen — where none lets it flap open and shut three times a second.
  const wobble = (n) => { const v = db(-30 + 2 * Math.sin((2 * Math.PI * 3 * n) / FS)) * Math.sin((2 * Math.PI * 440 * n) / FS); return [v, v]; };
  const g = run({ expd: expander({ threshDb: -30, floorDb: -30, hysteresisDb: 6, rangeDb: 60, holdMs: 0, releaseMs: 5 }) }, wobble, FS);
  let worst = 0;
  for (let n = FS / 2; n < FS; n++) worst = Math.max(worst, Math.abs(g.L[n]) / Math.max(Math.abs(wobble(n)[0]), 1e-9));
  assert.ok(worst < db(-59), `shut throughout once shut (${(20 * Math.log10(worst)).toFixed(1)} dB)`);
  const chatter = run({ expd: expander({ threshDb: -30, floorDb: -30, hysteresisDb: 0, rangeDb: 60, holdMs: 0, releaseMs: 5 }) }, wobble, FS);
  assert.ok(rmsDb(chatter.L, FS / 2, FS) > rmsDb(g.L, FS / 2, FS) + 20, "…where no hysteresis lets it reopen at the floor");
  // Between the floor and the threshold it is still an expander.
  const between = run({ expd: expander({ threshDb: -30, floorDb: -50, ratio: 2, rangeDb: 40, releaseMs: 10 }) }, tone(440, -40), FS);
  assert.ok(Math.abs(rmsDb(between.L, FS / 2, FS) - (-40 - 3.0103) - -10) < 0.05, "10 dB under the threshold, above the floor: 1:2 → 10 dB down");
  const under = run({ expd: expander({ threshDb: -30, floorDb: -38, ratio: 2, rangeDb: 40, releaseMs: 10 }) }, tone(440, -40), FS);
  assert.ok(Math.abs(rmsDb(under.L, FS / 2, FS) - (-40 - 3.0103) - -40) < 0.05, "…under the floor: shut, the whole range");
});

test("hold keeps the gate open that long after the level falls; the key filter keeps a bass out of the detector", () => {
  const burst = (n) => { const v = n < 4800 ? 0.5 * Math.sin((2 * Math.PI * 1000 * n) / FS) : 0.001 * Math.sin((2 * Math.PI * 1000 * n) / FS); return [v, v]; };
  const closedBy = (holdMs) => {
    const { L } = run({ expd: expander({ threshDb: -30, floorDb: -30, rangeDb: 60, holdMs, releaseMs: 1 }) }, burst, 24000);
    for (let n = 4800; n < 24000; n++) if (Math.abs(L[n]) < 1e-5 && Math.abs(burst(n)[0]) > 5e-4) return n;
    return -1;
  };
  const W = Math.round(M.IMX_EXPD_WINDOW_SEC * FS);
  const quick = closedBy(0), held = closedBy(100);
  assert.ok(quick > 4800 + W - 1 && quick < 4800 + W + 400, `closes once the window lets go (${quick})`);
  assert.ok(Math.abs(held - quick - 4800) < 400, `100 ms of hold is 4800 samples later (${held - quick})`);
  // A loud 50 Hz under a quiet 3 kHz: unfiltered, the bass holds the gate open
  // for the quiet treble; through a 300 Hz key low cut, it does not.
  const mix = (n) => { const v = 0.5 * Math.sin((2 * Math.PI * 50 * n) / FS) + 0.002 * Math.sin((2 * Math.PI * 3000 * n) / FS); return [v, v]; };
  const gain = (o) => run({ expd: expander({ threshDb: -30, floorDb: -30, rangeDb: 40, releaseMs: 5, ...o }) }, mix, FS).chain.readGr(M.makeImixGrReadout()).expd;
  assert.ok(gain({}) > -1e-6, "the bass opens it");
  assert.ok(gain({ keyFilter: true, keyLowCut: 300 }) < -39, "keyed above the bass, it stays shut");
});

// ── what the editor reads ───────────────────────────────────────────────────

test("the meter reads the expander's deepest gain and its detector level; the snapshot carries both", async () => {
  const { chain } = run({ expd: expander({ threshDb: -20, ratio: 3, rangeDb: 24, releaseMs: 10 }) }, tone(440, -30), 9600);
  const r = chain.readGr(M.makeImixGrReadout());
  assert.ok(Math.abs(r.expd - -20) < 0.05, `10 dB under at 1:3 is 20 dB down (${r.expd})`);
  assert.ok(Math.abs(r.expdLvl - -30) < 0.1, `level ${r.expdLvl}`);
  const { fillSnapshotInto } = await import("../../core/worklet/engine-commands.js");
  const P = await import("../../core/worklet/protocol.js");
  const eng = new TaudEngine();
  loadIntoEngine(eng, parseTaud(await readFile(DEMO)), 0);
  const b = M.defaultImixBlock(1);
  b.equipment.expd = expander({ threshDb: -6, ratio: 4, rangeDb: 30 });
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
  assert.ok(f[P.SNAP_IM_BASE + P.SNAP_IM_EXPD_GR] < 0, `the expander's gain (${f[P.SNAP_IM_BASE + P.SNAP_IM_EXPD_GR]})`);
  assert.ok(f[P.SNAP_IM_BASE + P.SNAP_IM_EXPD_LVL] > -120, "…and its level");
  assert.equal(P.SNAP_EP_BASE, P.SNAP_IM_BASE + P.SNAP_IM_EXPD_LVL + 1, "they end the Mixing-tab block");
});

// ── TML ─────────────────────────────────────────────────────────────────────

const chainOfInst = (src) => interpret(`tml 2\nsong { bars: 1 }\n${src}`).instruments[0].chain;

test("TML: expander, in the tab's words — no floor is −∞, a key filter on when a cut is written", () => {
  const g = chainOfInst(`instrument S { wave: "sine", chain: { expander: { threshold: -40, floor: -40, range: 50, hold: 30, hysteresis: 5, key_low_cut: 200, mix: 0.9 } } }`).equipment.expd;
  assert.deepEqual([g.threshDb, g.floorDb, g.rangeDb, g.holdMs, g.hysteresisDb, g.keyFilter, g.keyLowCut, g.dry],
    [-40, -40, 50, 30, 5, true, 200, Math.round(255 * (1 - 0.9))]);
  const x = chainOfInst(`instrument S { wave: "sine", chain: { expander: { detector: "rms", ratio: 3 } } }`).equipment.expd;
  assert.deepEqual([x.floorDb, x.detector, x.ratio, x.keyFilter], [-Infinity, 1, 3, false]);
  const err = (body) => {
    try { chainOfInst(`instrument S { wave: "sine", chain: { expander: { ${body} } } }`); } catch (e) { if (e instanceof MotifError) return e.message; throw e; }
    assert.fail("expected a MotifError");
  };
  assert.match(err(`threshold: -90`), /threshold must be -80…0, not -90/);
  assert.match(err(`threshold: -40, floor: -30`), /the floor \(-30 dB\) must not be above the threshold \(-40 dB\)/);
  assert.match(err(`hysteresis: 3`), /a hysteresis is the floor's — give it a floor/);
  assert.match(err(`mode: "gate"`), /no option "mode"/);
});
