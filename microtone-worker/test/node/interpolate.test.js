// Block interpolation (item 181): the curves, the control-point rules, the
// staircase collapse, the effect-argument table, and the two menu shapes that
// offer the tool at all.
//
// Everything here runs against the PURE core (doc/interpolate.js) over raw cell
// bytes, plus the column-band predicate the right-click menu asks
// (ui/blocktools.js interpKinds) — no DOM, so the whole feature's decisions are
// pinned in Node rather than only in a browser smoke.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planInterpolate, seriesValues, easeAt, columnAccess, isInterpolatableFx,
  INTERP_SHAPES, PITCH_MODES, FX_INTERP,
} from "../../src/doc/interpolate.js";
import { emptyPatternBytes, cellStride, readVol, readPan, readElev } from "../../src/doc/patterntools.js";
import { interpKinds, blockToolItems, isBlockTool } from "../../src/ui/blocktools.js";
import { COL_NOTE, COL_INST, COL_VOL, COL_PAN, COL_FX, COL_FX2 } from "../../src/ui/edit.js";
import { EffectOp } from "../../src/engine/tables.js";
import en from "../../src/ui/lang/en.js";
import ko from "../../src/ui/lang/ko.js";

// ── a one-pattern bench ──
// `rows` cells of the given format, addressed as pattern 0 rows 0..n-1, with a
// lane covering all of them. Mirrors what the Patterns view hands the tool.

function bench(rows = 16, wide = false) {
  const w = cellStride(wide);
  const img = emptyPatternBytes(wide).subarray(0, 64 * w);
  const bytes = Uint8Array.from(img);
  const readCell = (pat, row) =>
    pat === 0 && row >= 0 && row < 64 ? bytes.slice(row * w, row * w + w) : null;
  const lane = [];
  for (let r = 0; r < rows; r++) lane.push({ pat: 0, row: r });
  const at = (row) => bytes.subarray(row * w, row * w + w);
  const commit = (writes) => { for (const wr of writes) bytes.set(wr.bytes, wr.row * w); };
  return { bytes, readCell, lane, at, commit, wide, w };
}

const setNote = (b, note) => { b[0] = note & 0xff; b[1] = (note >>> 8) & 0xff; };
const getNote = (b) => b[0] | (b[1] << 8);
/** Volume SET, in whichever format the buffer is. */
function setVol(b, v, wide) {
  if (wide) { b[3] = v & 0xff; b[8] = (b[8] & ~0x70) & 0xff; }
  else b[3] = v & 0x3f;
}
function setFx(b, op, arg, second = false) {
  const o = second ? 10 : 5;
  b[o] = op; b[o + 1] = arg & 0xff; b[o + 2] = (arg >>> 8) & 0xff;
}
const getFx = (b, second = false) => {
  const o = second ? 10 : 5;
  return { op: b[o], arg: b[o + 1] | (b[o + 2] << 8) };
};

// ── the curves ──

test("easeAt: every shape pins both ends", () => {
  for (const shape of INTERP_SHAPES) {
    assert.equal(easeAt(shape, 0), 0, `${shape} at 0`);
    assert.equal(easeAt(shape, 1), 1, `${shape} at 1`);
  }
});

test("easeAt: cosine is symmetric, SF2 concave hangs back and convex leads", () => {
  assert.ok(Math.abs(easeAt("cosine", 0.5) - 0.5) < 1e-12);
  for (let t = 0.05; t < 1; t += 0.05) {
    assert.ok(Math.abs(easeAt("cosine", t) + easeAt("cosine", 1 - t) - 1) < 1e-12,
      `cosine symmetric at ${t}`);
  }
  // FluidSynth's own tables: concave(0.5) = −(40/96)·log10(0.5) ≈ 0.1254.
  assert.ok(Math.abs(easeAt("concave", 0.5) - 0.12543) < 1e-4);
  assert.ok(Math.abs(easeAt("convex", 0.5) - 0.87457) < 1e-4);
  // …and they are each other's mirror, which is what makes them a PAIR.
  for (let t = 0.02; t < 1; t += 0.02) {
    assert.ok(Math.abs(easeAt("concave", t) + easeAt("convex", 1 - t) - 1) < 1e-9,
      `mirror at ${t}`);
  }
  assert.ok(easeAt("concave", 0.25) < 0.25, "concave lags a straight line");
  assert.ok(easeAt("convex", 0.25) > 0.25, "convex leads it");
});

test("seriesValues: linear hits the control points and the midpoint", () => {
  const s = seriesValues([{ i: 0, v: 0 }, { i: 4, v: 40 }], "linear");
  assert.deepEqual([...s.keys()], [0, 1, 2, 3, 4]);
  assert.equal(s.get(0), 0);
  assert.equal(s.get(2), 20);
  assert.equal(s.get(4), 40);
});

test("seriesValues: hermite passes through every control point", () => {
  const pts = [{ i: 0, v: 10 }, { i: 5, v: 40 }, { i: 9, v: 12 }];
  const s = seriesValues(pts, "hermite");
  for (const p of pts) assert.ok(Math.abs(s.get(p.i) - p.v) < 1e-9, `through ${p.i}`);
  // A peak in the middle means the spline overshoots on the way out of it —
  // that is the shape's whole reason for being on the list.
  assert.ok(s.get(6) > 40 - 1e-9 || s.get(4) > 40 - 1e-9 || s.get(3) > 30);
});

// ── control points and what is left alone ──

test("note: fills the gap and leaves the control points untouched", () => {
  const b = bench(9);
  setNote(b.at(0), 0x5000);
  setNote(b.at(8), 0x6000);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["note"] });
  assert.equal(plan.usable, 1);
  assert.equal(plan.points, 2);
  assert.equal(plan.writes.length, 7, "only the seven gaps are written");
  b.commit(plan.writes);
  for (let r = 0; r <= 8; r++) {
    assert.equal(getNote(b.at(r)), 0x5000 + r * 0x200, `row ${r}`);
  }
});

test("note: sentinels are neither control points nor targets", () => {
  const b = bench(9);
  setNote(b.at(0), 0x5000);
  setNote(b.at(4), 0x0001);   // key off, mid-glide
  setNote(b.at(8), 0x6000);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["note"] });
  assert.equal(plan.points, 2, "the key-off is not a third control point");
  b.commit(plan.writes);
  assert.equal(getNote(b.at(4)), 0x0001, "the key-off survives");
  assert.equal(getNote(b.at(3)), 0x5000 + 3 * 0x200, "the glide runs either side of it");
  assert.equal(getNote(b.at(5)), 0x5000 + 5 * 0x200);
});

test("reject: one control point is not enough to interpolate between", () => {
  const b = bench(8);
  setNote(b.at(0), 0x5000);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["note"] });
  assert.equal(plan.usable, 0);
  assert.equal(plan.writes.length, 0);
});

test("volume: a slide is blocked — never a control point, never overwritten", () => {
  const b = bench(9);
  setVol(b.at(0), 0x08, false);
  b.at(4)[3] = 0x40 | 0x04;           // selector 1 = slide up by 4
  setVol(b.at(8), 0x20, false);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["vol"] });
  assert.equal(plan.points, 2);
  b.commit(plan.writes);
  assert.deepEqual(readVol(b.at(4), 0, false), { value: 4, sel: 1 }, "the slide is intact");
  assert.deepEqual(readVol(b.at(2), 0, false), { value: 0x0e, sel: 0 });
  assert.deepEqual(readVol(b.at(6), 0, false), { value: 0x1a, sel: 0 });
});

test("volume + panning: one pass, one write list, both columns", () => {
  const b = bench(5);
  setVol(b.at(0), 0x10, false); b.at(0)[4] = 0x00;
  setVol(b.at(4), 0x20, false); b.at(4)[4] = 0x20;
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["vol", "pan"] });
  assert.equal(plan.usable, 2, "one curve per column");
  assert.equal(plan.writes.length, 3, "three rows, not six writes");
  b.commit(plan.writes);
  assert.deepEqual(readVol(b.at(2), 0, false), { value: 0x18, sel: 0 });
  assert.deepEqual(readPan(b.at(2), 0, false), { value: 0x10, sel: 0 });
});

test("wide cell: azimuth and elevation travel together, elevation stays signed", () => {
  const b = bench(5, true);
  const a0 = b.at(0), a4 = b.at(4);
  a0[4] = 0x40; a0[8] = (a0[8] & ~0x0f) | 0; a0[9] = 0xf0;      // az 64, el −16
  a4[4] = 0xc0; a4[8] = (a4[8] & ~0x0f) | 0; a4[9] = 0x10;      // az 192, el +16
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["pan"], wide: true });
  b.commit(plan.writes);
  assert.equal(readPan(b.at(2), 0, true).value, 128, "azimuth halfway");
  assert.equal(readElev(b.at(2), 0, true), 0, "elevation crosses zero the short way");
  assert.equal(readElev(b.at(1), 0, true), -8);
});

// ── effect arguments ──

test("fx: vibrato's speed and depth are two independent bytes", () => {
  const b = bench(5);
  setFx(b.at(0), EffectOp.OP_H, 0x1080);
  setFx(b.at(4), EffectOp.OP_H, 0x5000);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["fx"] });
  b.commit(plan.writes);
  assert.deepEqual(getFx(b.at(2)), { op: EffectOp.OP_H, arg: 0x3040 },
    "speed 10→50 and depth 80→00 do not bleed into one another");
});

test("fx: a different effect between two control points is left alone", () => {
  const b = bench(9);
  setFx(b.at(0), EffectOp.OP_H, 0x1010);
  setFx(b.at(4), EffectOp.OP_D, 0x0400);   // volume slide — not interpolatable
  setFx(b.at(8), EffectOp.OP_H, 0x5050);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["fx"] });
  b.commit(plan.writes);
  assert.deepEqual(getFx(b.at(4)), { op: EffectOp.OP_D, arg: 0x0400 });
  assert.equal(getFx(b.at(2)).op, EffectOp.OP_H);
});

test("fx: two different interpolatable effects each get their own curve", () => {
  const b = bench(9);
  setFx(b.at(0), EffectOp.OP_H, 0x1010);
  setFx(b.at(4), EffectOp.OP_H, 0x3030);
  setFx(b.at(5), EffectOp.OP_R, 0x1010);
  setFx(b.at(8), EffectOp.OP_R, 0x4040);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["fx"] });
  assert.equal(plan.usable, 2, "one curve for H, one for R, nothing across the join");
  b.commit(plan.writes);
  assert.equal(getFx(b.at(2)).op, EffectOp.OP_H);
  assert.equal(getFx(b.at(6)).op, EffectOp.OP_R);
});

test("fx: fields outside the ramp are inherited, and memory-recall args are not values", () => {
  const b = bench(5);
  // S $80xx — only the low byte is a pan position; the $80 form selector rides
  // along untouched.
  setFx(b.at(0), EffectOp.OP_S, 0x8000);
  setFx(b.at(4), EffectOp.OP_S, 0x8080);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["fx"] });
  b.commit(plan.writes);
  assert.deepEqual(getFx(b.at(2)), { op: EffectOp.OP_S, arg: 0x8040 });

  // `H $0000` recalls the last argument — it is a "carry on", not a zero.
  const c = bench(5);
  setFx(c.at(0), EffectOp.OP_H, 0x0000);
  setFx(c.at(4), EffectOp.OP_H, 0x4040);
  const plan2 = planInterpolate({ lanes: [c.lane], readCell: c.readCell, kinds: ["fx"] });
  assert.equal(plan2.usable, 0);
  assert.equal(plan2.points, 1);
});

test("fx: the interpolatable table excludes every nibble-packed slide pair", () => {
  for (const op of [EffectOp.OP_D, EffectOp.OP_K, EffectOp.OP_L, EffectOp.OP_N,
    EffectOp.OP_P, EffectOp.OP_Q, EffectOp.OP_W]) {
    assert.equal(FX_INTERP[op], undefined, `opcode ${op.toString(16)} stays out`);
  }
  // The forms that multiplex on a nibble are gated on the form, not the opcode.
  assert.equal(isInterpolatableFx(EffectOp.OP_S, 0x8040), true);
  assert.equal(isInterpolatableFx(EffectOp.OP_S, 0x7040), false);
  assert.equal(isInterpolatableFx(EffectOp.OP_T, 0x0012), false, "T tempo SLIDE");
  assert.equal(isInterpolatableFx(EffectOp.OP_T, 0xff20), false, "T extended set");
  assert.equal(isInterpolatableFx(EffectOp.OP_T, 0x8000), true, "T plain set");
  assert.equal(isInterpolatableFx(EffectOp.OP_5, 0xffff), false, "filter reset sentinel");
});

test("fx2 writes the second effect's slot and leaves the first alone", () => {
  const b = bench(5, true);
  setFx(b.at(0), EffectOp.OP_G, 0x0100);
  setFx(b.at(0), EffectOp.OP_O, 0x0000, true);
  setFx(b.at(4), EffectOp.OP_O, 0x4000, true);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["fx2"], wide: true });
  assert.equal(plan.usable, 0, "O $0000 recalls, so there is only one control point");
  setFx(b.at(0), EffectOp.OP_O, 0x1000, true);
  const plan2 = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["fx2"], wide: true });
  b.commit(plan2.writes);
  assert.deepEqual(getFx(b.at(2), true), { op: EffectOp.OP_O, arg: 0x2800 });
  assert.deepEqual(getFx(b.at(2)), { op: 0, arg: 0 }, "effect 1 untouched on a filled row");
  assert.deepEqual(getFx(b.at(0)), { op: EffectOp.OP_G, arg: 0x0100 });
});

// ── the staircase (item 181.6) ──

test("staircase: a dense stepped fade is detected and does nothing until collapsed", () => {
  const b = bench(16);
  const steps = [24, 24, 24, 24, 20, 20, 20, 20, 16, 16, 16, 16, 12, 12, 12, 12];
  steps.forEach((v, r) => setVol(b.at(r), v, false));
  const probe = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["vol"] });
  assert.equal(probe.stairs, true);
  assert.equal(probe.writes.length, 0, "with no gaps there is nothing to fill");

  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["vol"],
    collapse: true });
  b.commit(plan.writes);
  const out = [...Array(16).keys()].map((r) => readVol(b.at(r), 0, false).value);
  assert.deepEqual(out.slice(0, 5), [24, 23, 22, 21, 20], "the flats become a ramp");
  assert.equal(out[12], 12, "the last step's start is still a control point");
  assert.deepEqual(out.slice(13), [12, 12, 12], "past the last control point nothing moves");
  for (let r = 1; r < 12; r++) assert.ok(out[r] <= out[r - 1], "monotone throughout");
});

test("staircase: dense but all-distinct is not a staircase", () => {
  const b = bench(16);
  for (let r = 0; r < 16; r++) setVol(b.at(r), 8 + r, false);
  const probe = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["vol"] });
  assert.equal(probe.stairs, false);
});

test("staircase: a sparse column with steps in it is not one either", () => {
  const b = bench(16);
  for (const r of [0, 1, 8, 9]) setVol(b.at(r), 8 + r, false);
  const probe = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["vol"] });
  assert.equal(probe.stairs, false, "there are still gaps to fill the ordinary way");
  assert.ok(probe.writes.length > 0);
});

// ── dither ──

test("dither: output is always one of the two integers the exact value sits between", () => {
  const b = bench(9);
  setVol(b.at(0), 20, false);
  setVol(b.at(8), 24, false);
  let n = 0;
  const rng = () => [0.9, 0.1, 0.5, 0.05, 0.95, 0.3, 0.7][n++ % 7];
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["vol"],
    dither: true, rng });
  b.commit(plan.writes);
  for (let r = 1; r <= 7; r++) {
    const exact = 20 + r * 0.5;
    const v = readVol(b.at(r), 0, false).value;
    assert.ok(v === Math.floor(exact) || v === Math.ceil(exact), `row ${r}: ${v} vs ${exact}`);
  }
  // Deterministic given the rng, which is the point of injecting one.
  const c = bench(9);
  setVol(c.at(0), 20, false); setVol(c.at(8), 24, false);
  n = 0;
  const again = planInterpolate({ lanes: [c.lane], readCell: c.readCell, kinds: ["vol"],
    dither: true, rng });
  assert.deepEqual(again.writes.map((w) => [...w.bytes]), plan.writes.map((w) => [...w.bytes]));
});

// ── glissando ──

test("glissando: writes only where the notation's degree changes", () => {
  const b = bench(13);
  setNote(b.at(0), 0x5000);            // C4
  setNote(b.at(12), 0x5400);           // three 12-TET semitones up (0x155 each)
  const snap = (note) => Math.round((note - 0x5000) / 0x155) * 0x155 + 0x5000;
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["note"],
    pitchMode: "glissando", snapNote: snap });
  b.commit(plan.writes);
  const written = [];
  for (let r = 1; r < 12; r++) if (getNote(b.at(r)) !== 0) written.push([r, getNote(b.at(r))]);
  assert.ok(written.length > 0 && written.length < 11,
    `a step glide writes some rows, not all eleven (got ${written.length})`);
  for (const [, note] of written) {
    assert.equal((note - 0x5000) % 0x155, 0, "every emitted note is on a degree");
  }
  for (let i = 1; i < written.length; i++) {
    assert.notEqual(written[i][1], written[i - 1][1], "no degree is emitted twice running");
  }
});

test("glissando: continuous mode writes every row instead", () => {
  const b = bench(13);
  setNote(b.at(0), 0x5000);
  setNote(b.at(12), 0x5400);
  const plan = planInterpolate({ lanes: [b.lane], readCell: b.readCell, kinds: ["note"],
    pitchMode: "continuous" });
  assert.equal(plan.writes.length, 11);
});

// ── lanes ──

test("lanes: a hole in the song keeps the curve's spacing", () => {
  const b = bench(9);
  setVol(b.at(0), 0, false);
  setVol(b.at(8), 32, false);
  // The same eight rows, but rows 3..5 are a stretch this channel has no
  // pattern on: the ramp either side must still be the ramp of a NINE-row span.
  const holed = b.lane.map((c, i) => (i >= 3 && i <= 5 ? null : c));
  const plan = planInterpolate({ lanes: [holed], readCell: b.readCell, kinds: ["vol"] });
  b.commit(plan.writes);
  assert.equal(readVol(b.at(2), 0, false).value, 8);
  assert.equal(readVol(b.at(6), 0, false).value, 24);
  assert.equal(plan.writes.length, 4, "the three missing rows are not written");
});

test("lanes: two channels sharing a pattern are one lane, not a fight", () => {
  const b = bench(5);
  setVol(b.at(0), 0, false);
  setVol(b.at(4), 32, false);
  const plan = planInterpolate({ lanes: [b.lane, b.lane.map((c) => ({ ...c }))],
    readCell: b.readCell, kinds: ["vol"] });
  assert.equal(plan.usable, 1, "the duplicate lane is dropped");
  const seen = new Set(plan.writes.map((w) => `${w.pat}:${w.row}`));
  assert.equal(seen.size, plan.writes.length, "no cell is written twice");
});

// ── the menu predicate (item 181.8) ──

test("interpKinds: one interpolatable column, or volume and panning together", () => {
  assert.deepEqual(interpKinds([COL_NOTE]), ["note"]);
  assert.deepEqual(interpKinds([COL_VOL]), ["vol"]);
  assert.deepEqual(interpKinds([COL_PAN]), ["pan"]);
  assert.deepEqual(interpKinds([COL_FX]), ["fx"]);
  assert.deepEqual(interpKinds([COL_VOL, COL_PAN]), ["vol", "pan"]);
  // The instrument column is a number but not a quantity — nothing sits
  // halfway between instrument 3 and instrument 7.
  assert.equal(interpKinds([COL_INST]), null);
  assert.equal(interpKinds([]), null);
  assert.equal(interpKinds([COL_NOTE, COL_INST]), null);
  assert.equal(interpKinds([COL_NOTE, COL_INST, COL_VOL, COL_PAN]), null);
  assert.equal(interpKinds([COL_PAN, COL_FX]), null);
  // The second effect exists only in the wide cell.
  assert.equal(interpKinds([COL_FX2], false), null);
  assert.deepEqual(interpKinds([COL_FX2], true), ["fx2"]);
});

test("the menu cell needs a BLOCK, not just the right column", () => {
  const ids = (cols, opts) => blockToolItems(cols, opts).map((i) => i.id).join(",");
  // A single clicked cell is one row, and one row can never hold two control
  // points — so the cell that could only answer "no" is not shown at all.
  assert.equal(ids([COL_VOL], {}), "volume,findchange");
  assert.equal(ids([COL_VOL], { block: true }), "volume,interpolate,findchange");
  assert.equal(ids([COL_NOTE], { block: true }), "transpose,interpolate,findchange");
  assert.equal(ids([COL_INST], { block: true }), "instrument,findchange");
  assert.equal(ids([COL_VOL, COL_PAN], { block: true }), "volume,pan,interpolate,findchange");
  assert.equal(ids([COL_PAN], { block: true, surround: true }),
    "pan,panner,interpolate,findchange");
  // The effect column's row is the quick palette, and Interpolate closes it
  // beside Find & Change there too.
  assert.ok(ids([COL_FX], { block: true }).endsWith("interpolate,findchange"));
  assert.ok(!ids([COL_FX], {}).includes("interpolate"));
  assert.equal(isBlockTool("interpolate"), true);
});

test("a curve's name and its description are separate strings", () => {
  // The option text sets the width of the closed dropdown, so the names stay
  // bare and the sentence lives in the field's hint (modal.js `hints`). A
  // description that crept back into the name would widen the whole dialog.
  for (const k of INTERP_SHAPES) {
    for (const [lang, tbl] of [["en", en], ["ko", ko]]) {
      const name = tbl[`interp.shape.${k}`];
      const desc = tbl[`interp.shapeDesc.${k}`];
      assert.ok(name && desc, `${lang} names and describes ${k}`);
      assert.ok(!/[—:(]/.test(name), `${lang} ${k} name is bare: ${name}`);
      assert.ok(name.length <= 12, `${lang} ${k} name stays short: ${name}`);
      assert.ok(desc.length > name.length, `${lang} ${k} description is the long half`);
    }
  }
  assert.equal(en["interp.shapeHint"], undefined, "the old generic hint is gone");
});

test("the mode lists are what the dialog offers", () => {
  assert.deepEqual(INTERP_SHAPES, ["linear", "cosine", "concave", "convex", "hermite"]);
  assert.deepEqual(PITCH_MODES, ["continuous", "glissando"]);
  assert.equal(columnAccess("instrument", false), null);
});

// ── the document-level glue ──
// interpolateTool's own plumbing, minus the dialog: the same readCell it builds
// out of the live document, the same setCellsBytesOp it commits with, and the
// same undo stack. A curve that is right over loose bytes and wrong over a real
// pattern is still wrong.

test("over a real document: one undo step, and the cells really move", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const { Document } = await import("../../src/doc/document.js");
  const { UndoStack } = await import("../../src/doc/undo.js");
  const { setCellsBytesOp } = await import("../../src/doc/ops.js");
  const { cellToBytes } = await import("../../src/doc/clipboard.js");

  const corpus = fileURLToPath(new URL("../corpus/", import.meta.url));
  const doc = new Document(parseTaud(readFileSync(corpus + "WHEN.taud")));
  const undo = new UndoStack(doc);
  const wide = doc.wideCells === true;
  const readCell = (pat, row) => {
    const cell = doc.patternAt(0, pat)?.[row];
    return cell ? cellToBytes(cell, wide) : null;
  };

  // Clear the volume column over rows 0..12 of pattern 1, then anchor each end.
  const pat = doc.songs[0].patterns[1];
  for (let r = 0; r <= 12; r++) { pat[r].volume = 0; pat[r].volumeEff = 3; }
  pat[0].volume = 0; pat[0].volumeEff = 0;
  pat[12].volume = 48; pat[12].volumeEff = 0;

  const lane = [];
  for (let r = 0; r <= 12; r++) lane.push({ pat: 1, row: r });
  const plan = planInterpolate({ lanes: [lane], readCell, kinds: ["vol"], wide });
  assert.equal(plan.writes.length, 11);

  const before = undo.undoStack.length;
  undo.apply(setCellsBytesOp(0, plan.writes));
  assert.equal(undo.undoStack.length, before + 1, "one undo step for the lot");
  assert.equal(pat[6].volume, 24);
  assert.equal(pat[6].volumeEff, 0);
  assert.equal(pat[3].volume, 12);
  assert.equal(pat[0].volume, 0, "the control points are untouched");
  assert.equal(pat[12].volume, 48);

  undo.undo();
  assert.equal(pat[6].volumeEff, 3, "and it undoes back to an empty column");

  // Idempotent: re-running over the finished ramp finds no gaps left to fill.
  undo.redo();
  const again = planInterpolate({ lanes: [lane], readCell, kinds: ["vol"], wide });
  assert.equal(again.writes.length, 0);
});

test("a curve runs through a pattern nobody has edited yet", async () => {
  const { Document } = await import("../../src/doc/document.js");
  const { UndoStack } = await import("../../src/doc/undo.js");
  const { setCellsBytesOp } = await import("../../src/doc/ops.js");
  const { cellToBytes } = await import("../../src/doc/clipboard.js");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { parseTaud } = await import("../../src/format/taud-parse.js");
  const corpus = fileURLToPath(new URL("../corpus/", import.meta.url));
  const doc = new Document(parseTaud(readFileSync(corpus + "WHEN.taud")));
  const undo = new UndoStack(doc);
  const wide = doc.wideCells === true;
  // The reader the tool builds: an unmaterialised index reads as the shared
  // empty pattern rather than as nothing, which is what lets a ramp cross it.
  const readCell = (pat, row) => {
    const cell = (doc.patternAt(0, pat) ?? doc.emptyPattern())[row];
    return cell ? cellToBytes(cell, wide) : null;
  };
  const free = doc.songs[0].freePatternNumbers(1)[0];
  assert.equal(doc.patternAt(0, free), null, "the bench pattern really is unmaterialised");

  // Anchor two rows of it, then interpolate the twelve between.
  const seedBytes = cellToBytes(doc.emptyPattern()[0], wide);
  const set = (row, vol) => {
    const b = Uint8Array.from(seedBytes);
    if (wide) { b[3] = vol; b[8] = (b[8] & ~0x70) & 0xff; } else b[3] = vol & 0x3f;
    return { pat: free, row, bytes: b };
  };
  undo.apply(setCellsBytesOp(0, [set(0, 0), set(12, 48)]));

  const lane = [];
  for (let r = 0; r <= 12; r++) lane.push({ pat: free, row: r });
  const plan = planInterpolate({ lanes: [lane], readCell, kinds: ["vol"], wide });
  assert.equal(plan.usable, 1);
  assert.equal(plan.writes.length, 11);
  undo.apply(setCellsBytesOp(0, plan.writes));
  assert.equal(doc.songs[0].patterns[free][6].volume, 24);
  assert.equal(doc.songs[0].patterns[free][6].volumeEff, 0);
});
