// Microtone Touch's pure half: the keyboard lattice, the synthesised preset
// bank, and a sketch's road to a .mtsk and a .taud — checked against the REAL
// parser and the REAL engine (both from core/), not against copies of them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  edoSteps, layoutSteps, reachesAll, layoutWorks, fitLayout, keyDegree, hexCentre, pixelToHex, visibleKeys, LAYOUTS,
  findFloor, octaveStep, tiltFor, riseToRight, riseUpwards, fatZone, fatPoints, FAT_CORNER, FAT_EDGE, FAT_SLACK,
} from "../../src/lattice.js";
import { buildBank, PRESETS, DRUMS } from "../../core/sketch/pack.js";
import {
  newSketch, normaliseSketch, toTaudDoc, sketchToTaud, sketchToFile, sketchFromFile, patternBytes, isBlank,
  sketchFileName, sketchDigest, emptySection, NOTE_OFF, LANES, ROWS, TUNINGS, FX, FX_IDS, tuningById,
} from "../../src/sketch.js";
import { cleanName, NAME_MAX } from "../../src/library.js";
import { onlineName, shownName } from "../../src/saving.js";
import { compilePattern, readPatterns } from "../../../tools/stage-site.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sketchFileToTaud, parseSketch, writeSketch, SketchFormatError } from "../../core/sketch/mtsk.js";
import { originPeriod } from "../../src/keyboard.js";
import { noteLabel, noteShade } from "../../src/notes.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TaudInst } from "../../core/engine/inst.js";
import { TRACKER_CHUNK, SAMPLING_RATE, JAM_VOICE_BASE } from "../../core/engine/constants.js";
import { SAMPLEBIN_SIZE, INST_RECORD_SIZE } from "../../core/format/taud-const.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { pitchTablePresets, noteForDegree } from "../../core/tuning/pitchtables.js";

const bank = buildBank();
const C4_HZ = 440 * 2 ** (-9 / 12);

// ── lattice ──────────────────────────────────────────────────────────────────

/** Just a layout's two steps (it also carries its octave step and tilt). */
const ab = ({ a, b }) => ({ a, b });

test("lattice: a tuning's own intervals, from its patent fifth", () => {
  assert.deepEqual(edoSteps(12), { n: 12, fifth: 7, tone: 2, limma: 1, apotome: 1, major3: 4, minor3: 3 });
  assert.deepEqual(edoSteps(31), { n: 31, fifth: 18, tone: 5, limma: 3, apotome: 2, major3: 10, minor3: 8 });
  assert.deepEqual(ab(layoutSteps("wicki", 12)), { a: 2, b: 7 });
  assert.deepEqual(ab(layoutSteps("harmonic", 12)), { a: 4, b: 7 });
  assert.deepEqual([layoutSteps("bosanquet", 53).a, layoutSteps("bosanquet", 53).b], [9, 5]);
});

test("lattice: Bosanquet–Wilson is whole tones one way and the chromatic semitone the other", () => {
  for (const n of [12, 19, 31, 53]) {
    const s = edoSteps(n);
    const L = layoutSteps("bosanquet", n);
    assert.equal(keyDegree(1, 0, L), s.tone, `${n}-TET: a whole tone up-right`);
    assert.equal(keyDegree(0, 1, L), s.apotome, `${n}-TET: the chromatic semitone straight up`);
    assert.equal(keyDegree(-1, 1, L), -s.limma, `${n}-TET: down a diatonic semitone up-left`);
  }
});

test("lattice: Bosanquet's floors — each repeat of the root's row is an octave up", () => {
  const floorOf = (n) => layoutSteps(fitLayout("bosanquet", n), n).floor ?? null;
  // The walk up from the root finds the root itself (12, 19) or its
  // right-hand neighbour (17, 22: C → D) — and from 31 tones up it walks past
  // the key a degree off two rows up, to the exact repeat a whole tone's
  // worth of rows up (see "every degree is on the board" below).
  assert.deepEqual(floorOf(12), { rows: 2, lift: 12 });
  assert.deepEqual(floorOf(17), { rows: 3, lift: 17 });
  assert.deepEqual(floorOf(19), { rows: 3, lift: 19 });
  assert.deepEqual(floorOf(22), { rows: 4, lift: 22 });
  assert.deepEqual(floorOf(31), { rows: 5, lift: 31 });
  assert.deepEqual(floorOf(41), { rows: 7, lift: 41 });
  assert.deepEqual(floorOf(43), { rows: 7, lift: 43 });
  assert.deepEqual(floorOf(53), { rows: 9, lift: 53 });
  // 7- and 9-TET (and 5, 8, 16) already climb an octave a floor: nothing to lift.
  for (const n of [5, 7, 8, 9, 16]) assert.equal(floorOf(n), null, `${n}-TET`);
  // …and no other layout has floors at all.
  for (const id of ["wicki", "harmonic", "step"]) assert.equal(layoutSteps(id, 12).floor, undefined, id);

  // Where the walk lands, one floor up is now one octave up.
  const at = (n, q, r) => keyDegree(q, r, layoutSteps("bosanquet", n));
  assert.equal(at(12, -1, 2), 12, "12-TET: C straight above C, an octave up");
  assert.equal(at(19, -1, 3), 19, "19-TET: the same");
  assert.equal(at(22, -2, 4), 22 + 4, "22-TET: D above C, an octave up");
  assert.equal(at(22, -3, 4), 22, "…with C an octave up beside it");
  assert.equal(at(31, -2, 5), 31, "31-TET: C, five rows up, an octave up");
  // Inside a floor the board is still plain Bosanquet; the floor below is an
  // octave down.
  assert.equal(at(12, 3, 1), 2 * 3 + 1, "row 1 is in the root's floor");
  assert.equal(at(12, 0, -1), -1 - 12, "row −1 is the floor below");
  assert.equal(findFloor({ a: 1, b: 2 }, 9), null);
});

test("lattice: every degree is on the board, floors and all, in every tuning and layout", () => {
  // Not one note missing across three periods, for every layout as fitted. (A
  // two-row floor in 31-TET would fail this: C4 on no key at all.)
  for (const t of TUNINGS) {
    const p = pitchTablePresets[t.notation];
    const n = p.table.length;
    for (const { id } of LAYOUTS) {
      const steps = layoutSteps(fitLayout(id, n, p.interval), n, p.interval);
      const on = new Set();
      for (let q = -60; q <= 60; q++) for (let r = -40; r <= 40; r++) on.add(keyDegree(q, r, steps));
      const missing = [];
      for (let d = -n; d < 2 * n; d++) if (!on.has(d)) missing.push(d);
      assert.deepEqual(missing, [], `${t.name} / ${id}`);
    }
  }
});

test("lattice: every offered tuning gets a layout that works, whichever is asked for", () => {
  for (const t of TUNINGS) {
    const p = pitchTablePresets[t.notation];
    assert.ok(p && p.table.length > 0, `${t.name} has a pitch table`);
    for (const { id } of LAYOUTS) {
      const fit = fitLayout(id, p.table.length, p.interval);
      const steps = layoutSteps(fit, p.table.length, p.interval);
      assert.ok(layoutWorks(steps, p.table.length), `${t.name} / ${id} → ${fit} ${JSON.stringify(steps)}`);
    }
  }
  // The small ones that need the fallback for everything but the run.
  assert.equal(fitLayout("wicki", 4), "step", "4-TET has no whole tone at all");
  assert.equal(fitLayout("harmonic", 4), "step", "4-TET has no major third either");
  assert.equal(fitLayout("wicki", 7), "wicki");
  assert.equal(fitLayout("wicki", 13, 0x195c), "wicki", "Bohlen–Pierce");
});

test("lattice: a layout that cannot reach every degree falls back to the degree run", () => {
  // 24-TET's patent fifth is 12-TET's: those three only ever reach even degrees.
  for (const id of ["wicki", "bosanquet", "harmonic"]) {
    assert.equal(reachesAll(layoutSteps(id, 24), 24), false, id);
    assert.equal(fitLayout(id, 24), "step");
  }
  for (const n of [12, 17, 19, 22, 31, 41, 43, 53]) assert.equal(fitLayout("wicki", n), "wicki", `${n}-TET`);
  for (const n of [12, 24, 53]) assert.ok(reachesAll(layoutSteps("step", n), n));
  assert.deepEqual(LAYOUTS.map((l) => l.id), ["wicki", "bosanquet", "harmonic", "step"]);
});

test("lattice: every key's centre maps back to that key, and its neighbours are the layout", () => {
  for (let q = -6; q <= 6; q++) {
    for (let r = -4; r <= 4; r++) {
      const c = hexCentre(q, r, 30);
      assert.deepEqual(pixelToHex(c.x, c.y, 30), { q, r });
      // …and a point well inside the key still lands on it.
      assert.deepEqual(pixelToHex(c.x + 9, c.y - 9, 30), { q, r });
    }
  }
  const L = layoutSteps("wicki", 12);
  assert.equal(keyDegree(1, 0, L), 2, "up-right = a whole tone");
  assert.equal(keyDegree(0, 1, L), 7, "straight up = a fifth");
  assert.equal(keyDegree(-1, 1, L), 5, "up-left = a fourth");
});

test("lattice: a pointy-topped board turned by a tilt — neighbours at tilt, +60°, +120°", () => {
  for (const tilt of [0, 0.3, -0.28, Math.PI / 2, 2.06]) {
    const o = hexCentre(0, 0, 30, tilt);
    const along = (q, r) => { const p = hexCentre(q, r, 30, tilt); return { dx: p.x - o.x, dy: o.y - p.y }; };
    const angle = (q, r) => { const v = along(q, r); return Math.atan2(v.dy, v.dx); };
    const same = (x, y) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y))) < 1e-9;
    assert.ok(same(angle(1, 0), tilt), `a runs at the tilt (${tilt})`);
    assert.ok(same(angle(0, 1), tilt + Math.PI / 3), "b at tilt + 60°");
    assert.ok(same(angle(-1, 1), tilt + (2 * Math.PI) / 3), "b − a at tilt + 120°");
    for (const [q, r] of [[1, 0], [0, 1], [-1, 1]]) {
      const v = along(q, r);
      assert.ok(Math.abs(Math.hypot(v.dx, v.dy) - 30 * Math.sqrt(3)) < 1e-9, "all three are neighbours");
    }
    // …and the inverse finds every key again, turned or not.
    for (let q = -5; q <= 5; q++) {
      for (let r = -5; r <= 5; r++) {
        const c = hexCentre(q, r, 30, tilt);
        assert.deepEqual(pixelToHex(c.x + 7, c.y - 6, 30, tilt), { q, r });
      }
    }
  }
});

test("lattice: every layout stands the head key's octaves in a vertical column", () => {
  for (const t of TUNINGS) {
    const p = pitchTablePresets[t.notation];
    const n = p.table.length;
    for (const { id } of LAYOUTS) {
      const steps = layoutSteps(fitLayout(id, n, p.interval), n, p.interval);
      const name = `${t.name} / ${id}`;
      assert.ok(steps.octave, `${name} has an octave step`);
      const { q, r } = steps.octave;
      for (let m = -2; m <= 2; m++) {
        assert.equal(keyDegree(m * q, m * r, steps), m * n, `${name}: ${m} octaves`);
        const c = hexCentre(m * q, m * r, 1, steps.tilt);
        assert.ok(Math.abs(c.x) < 1e-9, `${name}: octave ${m} is straight above/below (x ${c.x})`);
        assert.ok(m === 0 || Math.sign(-c.y) === Math.sign(m), `${name}: up is up`);
      }
      assert.ok(riseToRight(steps, steps.tilt) >= -1e-9, `${name}: the board does not fall to the right`);
      // Not only the head key: on these layouts every key's octave is above it.
      for (let kq = -4; kq <= 4; kq++) {
        for (let kr = -6; kr <= 6; kr++) {
          assert.equal(keyDegree(kq + q, kr + r, steps) - keyDegree(kq, kr, steps), n, `${name} at (${kq}, ${kr})`);
        }
      }
    }
  }
  const deg = (id, n) => Math.round((layoutSteps(id, n).tilt * 180) / Math.PI * 10) / 10;
  assert.equal(deg("wicki", 12), 0, "Wicki–Hayden is upright already");
  assert.equal(deg("wicki", 31), 0);
  assert.equal(deg("bosanquet", 12), 0);
  assert.equal(deg("bosanquet", 19), 10.9);
  assert.equal(deg("bosanquet", 22), -16.1, "22-TET Bosanquet turns clockwise: its octave is (−3, 4)");
  assert.equal(deg("harmonic", 12), -30, "the harmonic table: four keys up, not three major thirds across");
  assert.ok(riseToRight(layoutSteps("harmonic", 12), Math.PI / 2) < 0, "…which, stood upright, would fall to the right");
  assert.equal(Math.round(tiltFor({ q: -1, r: 2 }) * 1e9), 0);
  assert.equal(octaveStep({ a: 2, b: 4 }, 7), null, "a board that never reaches the octave has no step");
});

test("lattice: the harmonic table lays its octaves across — C E G♯ C′ along a level row", () => {
  const h12 = layoutSteps("harmonic", 12, undefined, true);
  assert.equal(h12.across, true);
  assert.deepEqual(h12.octave, { q: 3, r: 0 }, "three major thirds");
  assert.equal(h12.tilt, 0, "the row of thirds is the board's own level axis");
  assert.deepEqual([0, 1, 2, 3].map((q) => keyDegree(q, 0, h12)), [0, 4, 8, 12]);
  assert.equal(layoutSteps("harmonic", 12).across, false, "upright unless asked");
  assert.equal(Math.round((layoutSteps("harmonic", 12).tilt * 180) / Math.PI), -30);

  for (const t of TUNINGS) {
    const p = pitchTablePresets[t.notation];
    const n = p.table.length;
    if (fitLayout("harmonic", n, p.interval) !== "harmonic") continue;
    const steps = layoutSteps("harmonic", n, p.interval, true);
    assert.ok(steps.across, `${t.name}: has an octave to lay across`);
    const { q, r } = steps.octave;
    for (let m = -2; m <= 2; m++) {
      assert.equal(keyDegree(m * q, m * r, steps), m * n, `${t.name}: ${m} octaves`);
      const c = hexCentre(m * q, m * r, 1, steps.tilt);
      assert.ok(Math.abs(c.y) < 1e-9, `${t.name}: octave ${m} is level with the head key (y ${c.y})`);
      assert.ok(m === 0 || Math.sign(c.x) === Math.sign(m), `${t.name}: up an octave is to the right`);
    }
    assert.ok(riseUpwards(steps, steps.tilt) >= -1e-9, `${t.name}: the board does not fall going up`);
    assert.ok(riseToRight(steps, steps.tilt) > 0, `${t.name}: …and climbs to the right`);
  }
  // What climbs up a board turned by t climbs to the right of one turned by t − 90°.
  assert.ok(Math.abs(riseUpwards(h12, 0) - 10 / Math.sqrt(3)) < 1e-9, "a minor seventh per row pair straight up");
  // A board with no level octave stands upright instead, and says so:
  // 19-TET Bosanquet's floors are three rows tall, and no step spanning whole
  // floors lies level with the board still climbing upwards.
  const b19 = layoutSteps("bosanquet", 19, undefined, true);
  assert.equal(b19.across, false);
  assert.deepEqual([b19.octave, b19.tilt], [layoutSteps("bosanquet", 19).octave, layoutSteps("bosanquet", 19).tilt]);
});

test("lattice: fat fingers — a key's middle plays it, its edges two keys, its corners three", () => {
  const size = 30;
  for (const tilt of [0, -Math.PI / 6, 0.19, 2.06]) {
    const at = (q, r) => hexCentre(q, r, size, tilt);
    const keysOf = (z) => z.keys.map(({ q, r }) => `${q},${r}`).sort();
    // The middle, and well inside the rim, is the key itself.
    const mid = at(2, -1);
    assert.deepEqual(keysOf(fatZone(mid.x, mid.y, size, tilt)), ["2,-1"]);
    assert.deepEqual(keysOf(fatZone(mid.x + 0.5 * size, mid.y, size, tilt)), ["2,-1"]);
    // An edge's midpoint is the two keys either side of it.
    const e = hexCentre(2.5, -1, size, tilt);
    assert.deepEqual(keysOf(fatZone(e.x, e.y, size, tilt)), ["2,-1", "3,-1"]);
    // A corner is the three keys around it.
    const v = hexCentre(2 + 1 / 3, -1 + 1 / 3, size, tilt);
    assert.deepEqual(keysOf(fatZone(v.x, v.y, size, tilt)), ["2,-1", "2,0", "3,-1"]);
    // No stretch of a rim belongs to one key alone: walk an edge corner to corner.
    const c0 = hexCentre(2 + 1 / 3, -1 + 1 / 3, size, tilt), c1 = hexCentre(2 + 2 / 3, -1 - 1 / 3, size, tilt);
    for (let i = 0; i <= 40; i++) {
      const x = c0.x + ((c1.x - c0.x) * i) / 40, y = c0.y + ((c1.y - c0.y) * i) / 40;
      assert.ok(fatZone(x, y, size, tilt).keys.length > 1, `tilt ${tilt}: rim point ${i}/40`);
    }
  }
});

test("lattice: fat fingers on the 12-TET harmonic table — every corner a triad, every edge a third or a fifth", () => {
  const h12 = layoutSteps("harmonic", 12);
  const pcs = (z) => z.keys.map(({ q, r }) => ((keyDegree(q, r, h12) % 12) + 12) % 12);
  const shape = (z) => {
    const p = pcs(z);
    for (const root of p) { // the triad's shape from whichever note makes it close
      const up = p.map((d) => (d - root + 12) % 12).sort((x, y) => x - y).join(" ");
      if (up === "0 4 7") return "major";
      if (up === "0 3 7") return "minor";
    }
    return p.length === 2 ? [(p[1] - p[0] + 12) % 12, (p[0] - p[1] + 12) % 12].sort((x, y) => x - y).join("/") : "?";
  };
  const seen = new Map();
  for (const p of fatPoints(0, 0).concat(fatPoints(1, 0), fatPoints(0, 1))) {
    const c = hexCentre(p.q, p.r, 30, h12.tilt);
    const s = shape(fatZone(c.x, c.y, 30, h12.tilt));
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  assert.deepEqual([...seen.keys()].sort(), ["3/9", "4/8", "5/7", "major", "minor"],
    "corners are major and minor triads; edges a minor third, a major third, a fifth (or their inversions)");
  assert.equal(seen.get("major"), 3);
  assert.equal(seen.get("minor"), 3);
});

test("lattice: a fat finger keeps its zone until it is clearly out of it", () => {
  const size = 40, tilt = 0;
  const v = hexCentre(1 / 3, 1 / 3, size, tilt);
  const corner = fatZone(v.x, v.y, size, tilt);
  assert.equal(corner.keys.length, 3);
  // Out along the line to the key's middle: just past the corner's own radius
  // it is still the corner for a finger already there, not for a new one.
  const c = hexCentre(0, 0, size, tilt);
  const toward = (d) => {
    const len = Math.hypot(c.x - v.x, c.y - v.y);
    return { x: v.x + ((c.x - v.x) * d * size) / len, y: v.y + ((c.y - v.y) * d * size) / len };
  };
  const p = toward(FAT_CORNER + FAT_SLACK / 2);
  assert.equal(fatZone(p.x, p.y, size, tilt).keys.length, 1, "a new finger there is on the key");
  assert.equal(fatZone(p.x, p.y, size, tilt, corner), corner, "the finger already on the corner keeps it");
  const q = toward(FAT_CORNER + FAT_SLACK * 2);
  assert.equal(fatZone(q.x, q.y, size, tilt, corner).keys.length, 1, "further out, it lets go");
  // And back in: a finger on the key reaches the corner only past the slack.
  const key = fatZone(q.x, q.y, size, tilt);
  const r = toward(FAT_CORNER - FAT_SLACK / 2);
  assert.equal(fatZone(r.x, r.y, size, tilt).keys.length, 3, "a new finger there is on the corner");
  assert.equal(fatZone(r.x, r.y, size, tilt, key), key, "the finger already on the key keeps it");
  const s = toward(FAT_CORNER - FAT_SLACK * 2);
  assert.equal(fatZone(s.x, s.y, size, tilt, key).keys.length, 3, "deeper in, it takes the corner");
  // The edge zone's slack works the same way.
  const e = hexCentre(0.5, 0, size, tilt);
  const edge = fatZone(e.x, e.y, size, tilt);
  assert.equal(edge.keys.length, 2);
  const out = { x: e.x - (FAT_EDGE + FAT_SLACK / 2) * size, y: e.y };
  assert.equal(fatZone(out.x, out.y, size, tilt).keys.length, 1);
  assert.equal(fatZone(out.x, out.y, size, tilt, edge), edge);
});

test("lattice: the fat-finger points drawn per key land on every corner and edge once", () => {
  const size = 10, tilt = 0.4;
  const drawn = new Map();
  for (let q = -4; q <= 4; q++) {
    for (let r = -4; r <= 4; r++) {
      for (const p of fatPoints(q, r)) {
        const c = hexCentre(p.q, p.r, size, tilt);
        const id = `${Math.round(c.x * 1000)},${Math.round(c.y * 1000)}`;
        assert.ok(!drawn.has(id), `(${q}, ${r}) draws ${id} again`);
        drawn.set(id, p.keys.length);
        // …each one being the zone it marks.
        const z = fatZone(c.x, c.y, size, tilt);
        assert.deepEqual(z.keys.map((k) => `${k.q},${k.r}`).sort(), p.keys.map((k) => `${k.q},${k.r}`).sort());
      }
    }
  }
  // An inner key's six corners and six edges are all among them.
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - tilt; // screen y runs down: corners at −tilt + 30° + 60°i, edges between
    for (const [d, n] of [[size, 3], [size * (Math.sqrt(3) / 2), 2]]) {
      const ang = n === 3 ? a - Math.PI / 6 : a;
      const id = `${Math.round(d * Math.cos(ang) * 1000)},${Math.round(d * Math.sin(ang) * 1000)}`;
      assert.equal(drawn.get(id), n, `key (0, 0): ${n === 3 ? "corner" : "edge"} ${i}`);
    }
  }
});

test("lattice: the layouts read as the Lumatone's preset charts", () => {
  // 19-ET Bosanquet: C D E climb the shallow axis, C♯ sits steeply above C,
  // and D♭ one row further up (the row of flats, in the same floor).
  const b19 = layoutSteps("bosanquet", 19);
  assert.deepEqual([keyDegree(1, 0, b19), keyDegree(0, 1, b19), keyDegree(0, 2, b19)], [3, 1, 2]);
  // 22-ET: a whole tone is 4, C♯ is 3 above C, and up-left is B, a degree down.
  const b22 = layoutSteps("bosanquet", 22);
  assert.deepEqual([keyDegree(1, 0, b22), keyDegree(0, 1, b22), keyDegree(-1, 1, b22)], [4, 3, -1]);
  // 12-ET Harmonic Table: major thirds on the shallow axis, fifths on the
  // steep one, minor thirds up and to the left.
  const h12 = layoutSteps("harmonic", 12);
  assert.deepEqual([keyDegree(1, 0, h12), keyDegree(0, 1, h12), keyDegree(-1, 1, h12)], [4, 7, 3]);
});

test("lattice: the visible keys cover the board without gaps, at any tilt", () => {
  const origin = { x: 40, y: 260 };
  for (const tilt of [0, 0.19, -0.28, Math.PI / 2, 2.06]) {
    const keys = visibleKeys(390, 300, 26, origin, tilt);
    assert.ok(keys.length > 40);
    for (let x = 2; x < 390; x += 13) {
      for (let y = 2; y < 300; y += 13) {
        const { q, r } = pixelToHex(x - origin.x, y - origin.y, 26, tilt);
        assert.ok(keys.some((k) => k.q === q && k.r === r), `tilt ${tilt}: (${x}, ${y}) → (${q}, ${r}) is drawn`);
      }
    }
  }
});

// ── the preset bank ──────────────────────────────────────────────────────────

test("presets: the bank is deterministic", () => {
  const again = buildBank();
  assert.deepEqual(again.slots, bank.slots);
  assert.ok(Buffer.from(again.image).equals(Buffer.from(bank.image)), "byte-identical image");
});

test("presets: every preset has a record pointing at real pool bytes", () => {
  const melodic = PRESETS.filter((p) => !p.kit);
  assert.deepEqual(melodic.map((p) => bank.slots[p.id]), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(bank.slots.drums, [8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(bank.names.length, 16);
  for (let slot = 1; slot <= 15; slot++) {
    const inst = new TaudInst(slot);
    const o = SAMPLEBIN_SIZE + slot * INST_RECORD_SIZE;
    inst.loadRecord(bank.image.subarray(o, o + INST_RECORD_SIZE));
    assert.ok(inst.sampleLength > 0 && inst.samplePtr + inst.sampleLength <= SAMPLEBIN_SIZE, `slot ${slot}`);
    assert.ok(inst.samplingRate > 0 && inst.samplingRate <= 0xffff);
    if (slot <= 7) {
      assert.equal(inst.loopMode & 3, 1, `slot ${slot} loops`);
      assert.ok(inst.sampleLoopEnd <= inst.sampleLength && inst.sampleLoopStart < inst.sampleLoopEnd);
      assert.ok((inst.volEnvLoop & 0x2000) !== 0, `slot ${slot}'s envelope is marked present`);
    } else {
      assert.ok(inst.isPercussion, `slot ${slot} is percussion, so a retune leaves it alone`);
    }
  }
});

test("presets: a melodic loop sounds C4 to within a few hundredths of a cent", () => {
  // The only error is the record's whole-Hz sampling rate. The pad's loop is
  // the worst at 0.025 cents — at C4, one beat against true pitch every two
  // minutes — and the single-cycle loops are under a hundredth.
  for (let slot = 1; slot <= 7; slot++) {
    const inst = new TaudInst(slot);
    const o = SAMPLEBIN_SIZE + slot * INST_RECORD_SIZE;
    inst.loadRecord(bank.image.subarray(o, o + INST_RECORD_SIZE));
    // Measure the loop's period from the bytes: the lag with the least
    // difference against itself, between half and twice the nominal.
    const loop = bank.image.subarray(inst.samplePtr + inst.sampleLoopStart, inst.samplePtr + inst.sampleLoopEnd);
    const len = loop.length;
    const cycles = slot === 6 ? 64.5 : slot === 7 ? 2 : 1; // the pad's chorus, the organ's sub-octave
    const hz = (inst.samplingRate / len) * cycles;
    const cents = 1200 * Math.log2(hz / C4_HZ);
    assert.ok(Math.abs(cents) < (slot === 6 ? 0.03 : 0.01), `slot ${slot}: ${cents.toFixed(4)} cents`);
  }
});

// ── the sketch ───────────────────────────────────────────────────────────────

function sketchWithTune() {
  const s = newSketch();
  const piano = s.sections[0].cells[0];
  piano[0] = { n: 0x5000 };
  piano[4] = { n: 0x5000 + 0x555, fx: "vibrato", lv: 2 };
  piano[12] = { n: NOTE_OFF };
  piano[16] = { n: 0x5800 };
  s.sections[0].cells[2][0] = { n: 0x5000, d: 0 }; // a kick on the drum lane
  s.sections[0].cells[2][8] = { n: 0x5000, d: 1 }; // …and a snare
  return s;
}

test("sketch: an effect lasts until the lane's next note or key-off", () => {
  const s = sketchWithTune();
  const bytes = patternBytes(s, 0, 0, bank);
  const op = (r) => bytes[r * 8 + 5];
  const arg = (r) => bytes[r * 8 + 6] | (bytes[r * 8 + 7] << 8);
  for (let r = 0; r < 4; r++) assert.equal(op(r), 0, `row ${r}: nothing yet`);
  for (let r = 4; r < 12; r++) {
    assert.equal(op(r), FX.vibrato.op, `row ${r} vibrates`);
    assert.equal(arg(r), FX.vibrato.args[2]);
  }
  assert.equal(op(12), 0, "the key-off ends it");
  assert.equal(bytes[12 * 8] | (bytes[12 * 8 + 1] << 8), NOTE_OFF);
  for (let r = 0; r < ROWS; r++) {
    assert.equal(bytes[r * 8 + 3], 0xc0, "no volume intent anywhere");
    assert.equal(bytes[r * 8 + 4], 0xc0, "no pan intent anywhere");
  }
  assert.equal(bytes[2], bank.slots.piano, "a note carries its lane's instrument");
  const drums = patternBytes(s, 0, 2, bank);
  assert.equal(drums[2], bank.slots.drums[0]);
  assert.equal(drums[8 * 8 + 2], bank.slots.drums[1]);
});

test("sketch: it survives the trip through writeTaud and parseTaud", () => {
  const s = sketchWithTune();
  s.name = "Ünïcode sketch";
  s.tuning = "31";
  s.bpm = 133;
  s.sections.push(structuredClone(s.sections[0]));
  const parsed = parseTaud(sketchToTaud(s, bank));
  const want = toTaudDoc(s, bank);
  const song = parsed.songs[0];
  assert.equal(song.bpm, 133);
  assert.equal(song.patterns.length, 2 * LANES);
  for (let p = 0; p < song.patterns.length; p++) {
    assert.deepEqual([...song.patterns[p]], [...want.songs[0].patterns[p]], `pattern ${p}`);
  }
  assert.equal(song.cues.length, 2);
  assert.equal(song.cues[1][0] & 0x7fff, LANES, "cue 1 plays section 1's first pattern");
  assert.ok(Buffer.from(parsed.sampleInstImage).equals(Buffer.from(bank.image)));
  assert.equal(parsed.meta.songMeta[0].notation, 310, "the tuning travels as the song's notation");
  assert.equal(song.tuningBaseNote, 0x5c00, "…at concert pitch");
  assert.equal(song.tuningFreq, 440);
  assert.equal(parsed.meta.projectName, "\\u00DCn\\u00EFcode sketch", "names ride the \\u escape");
});

test("sketch: the song loops by default, and a one-section loop is what the transport plays", () => {
  const s = sketchWithTune();
  s.sections.push(structuredClone(s.sections[0]), structuredClone(s.sections[0]));
  const word0 = (words) => {
    let w = 0;
    for (let c = 0; c < 16; c++) if (words[c] & 0x8000) w |= 1 << c;
    return w;
  };
  const doc = toTaudDoc(s, bank);
  assert.equal(word0(doc.songs[0].cues[2]), 0xf000, "JMP 0 on the last cue");
  assert.equal(word0(doc.songs[0].cues[0]), 0, "plain cues before it");
  s.loop = false;
  assert.equal(word0(toTaudDoc(s, bank).songs[0].cues[2]), 0x0100, "HALT when not looping");
  const one = toTaudDoc(s, bank, { only: 1 });
  assert.equal(one.songs[0].cues.length, 1);
  assert.equal(one.songs[0].cues[0][0] & 0x7fff, LANES);
  assert.equal(word0(one.songs[0].cues[0]), 0xf000, "a section on its own always loops");
  assert.equal(one.songs[0].patterns.length, 3 * LANES, "every pattern stays where it is");
});

test("sketch: junk from storage is dropped, not trusted", () => {
  assert.ok(isBlank(normaliseSketch(null)));
  assert.ok(isBlank(normaliseSketch({ v: 999, sections: [{ cells: [[{ n: 0x5000 }]] }] })));
  const s = normaliseSketch({
    v: 1, name: "x".repeat(200), bpm: 9999, tuning: "11", lanes: [{ preset: "theremin" }, { preset: "pad", mute: true }],
    sections: [{ cells: [[{ n: 0x5000, fx: "warp" }, { n: 5 }, { n: NOTE_OFF, d: 3 }, { n: 0x5000, d: 99, fx: "roll", lv: 7 }]] }],
  });
  assert.equal(s.name.length, 64);
  assert.equal(s.bpm, 300);
  assert.equal(s.tuning, "12");
  assert.equal(normaliseSketch({ v: 1, notation: 190 }).tuning, "19", "a sketch saved before tuning ids keeps its tuning");
  assert.equal(s.lanes[0].preset, "piano");
  assert.deepEqual(s.lanes[1], { preset: "pad", mute: true });
  const cells = s.sections[0].cells[0];
  assert.deepEqual(cells.slice(0, 4), [{ n: 0x5000 }, null, { n: NOTE_OFF }, { n: 0x5000, fx: "roll", lv: 2 }]);
  assert.equal(sketchFileName({ name: 'a/b:c*"d' }), "a b c d.taud");
  assert.equal(sketchFileName({ name: "riff" }, ".mtsk"), "riff.mtsk");
});

test("sketch: the digest tells an unsaved change from the sketch as it was saved", () => {
  const s = sketchWithTune();
  const saved = sketchDigest(s);
  assert.equal(sketchDigest(structuredClone(s)), saved, "a copy is the same sketch");
  assert.equal(sketchDigest(normaliseSketch(JSON.parse(JSON.stringify(s)))), saved,
    "…and so is the working copy read back from local storage");
  // Save as… keeps a renamed COPY, then renames the sketch in hand: the two
  // must come out the same, or a sketch would read as unsaved the moment it
  // was saved
  const copy = { ...structuredClone(s), name: "riff 2" };
  s.name = "riff 2";
  assert.equal(sketchDigest(s), sketchDigest(copy));
  assert.notEqual(sketchDigest(s), saved);
  s.name = sketchWithTune().name;
  s.sections[0].cells[3][5] = { n: 0x5100 };
  assert.notEqual(sketchDigest(s), saved, "one note is a change");
  s.sections[0].cells[3][5] = null;
  s.lanes[3].mute = !s.lanes[3].mute;
  assert.notEqual(sketchDigest(s), saved, "so is a mute");
});

test("about: package.json ships beside the page, where About reads its version", () => {
  const site = new URL("../../", import.meta.url);
  const ignored = readPatterns(fileURLToPath(new URL(".assetsignore", site))).map(compilePattern);
  assert.ok(!ignored.some((matches) => matches("package.json")), ".assetsignore must not drop package.json");
  const about = new URL("src/about.js", site);
  const path = readFileSync(about, "utf8").match(/new URL\("([^"]*package\.json)", import\.meta\.url\)/)?.[1];
  assert.ok(path && existsSync(new URL(path, about)), "about.js's path to package.json finds it");
  assert.match(JSON.parse(readFileSync(new URL("package.json", site), "utf8")).version, /^\d+\.\d+\.\d+/);
});

test("saving: a name as it is kept — on the phone as typed, online as a .mtsk", () => {
  assert.equal(cleanName("  Cafe\u0301 riff  "), "Caf\u00e9 riff", "NFC, trimmed: one name however it was typed");
  assert.equal(cleanName("   "), "");
  assert.equal(cleanName("x".repeat(200)).length, NAME_MAX);
  assert.equal(onlineName('a/b:c'), "a b c.mtsk");
  assert.equal(shownName("riff.mtsk"), "riff");
  assert.equal(shownName(onlineName("가락 one")), "가락 one");
  assert.equal(shownName("song.taud"), "song.taud", "a project is not a sketch");
});

test("sketch: a .mtsk carries everything a sketch is, and comes back as the same sketch", () => {
  for (const tuning of TUNINGS.map((t) => t.id)) {
    const s = sketchWithTune();
    s.name = "가락 one";
    s.tuning = tuning;
    s.bpm = 97;
    s.loop = tuning !== "bp";
    s.lanes[5].preset = "organ"; // written on, so it comes back
    s.sections[0].cells[5][3] = { n: 0x4800, fx: "slide", lv: 0 };
    s.sections.push(emptySection(), structuredClone(s.sections[0])); // a silent section in the middle survives
    s.sections[2].cells[1][63] = { n: 0x3000, fx: "fade", lv: 2 };
    const back = sketchFromFile(sketchToFile(s, bank), bank);
    assert.deepEqual(back, { ...s, lanes: s.lanes.map((l) => ({ ...l, mute: false })) }, tuning);
  }
  // every effect at every setting
  const s = newSketch();
  FX_IDS.forEach((fx, i) => [0, 1, 2].forEach((lv) => {
    s.sections[0].cells[0][i * 8 + lv * 2] = { n: 0x5000 + i, fx, lv };
  }));
  s.sections.push(...Array.from({ length: 15 }, emptySection));
  assert.deepEqual(sketchFromFile(sketchToFile(s, bank), bank).sections, s.sections);
});

test("sketch: what a .mtsk says that the sketch cannot hold is left behind, not misread", () => {
  const s = sketchWithTune();
  const bytes = sketchToFile(s, bank);
  // an empty lane keeps its default preset; a lane's own drum hits stay hits
  const back = sketchFromFile(bytes, bank);
  assert.equal(back.lanes[7].preset, newSketch().lanes[7].preset);
  assert.equal(back.sections[0].cells[2][8].d, 1);
  // a hand-made file: a note cut, a volume column, an effect Touch has not got
  const f = parseSketch(bytes);
  const p = f.patterns;
  p[2 * 8] = 0x02; p[2 * 8 + 1] = 0; // row 2, lane 0: note cut
  p[0 * 8 + 3] = 0x20; // a volume SET on row 0
  p[4 * 8 + 5] = 0x0f; // row 4's vibrato becomes an F
  const odd = sketchFromFile(writeSketch(f), bank);
  assert.equal(odd.sections[0].cells[0][2], null, "a sentinel Touch has no key for");
  assert.deepEqual(odd.sections[0].cells[0][4], { n: s.sections[0].cells[0][4].n }, "an unknown effect is dropped");
  assert.throws(() => sketchFromFile(Uint8Array.from([0x1f, 0x4d, 0x54, 0x73, 0x6b, 0x65, 0x63, 0x68, 9, ...new Uint8Array(23)]), bank),
    SketchFormatError);
});

test("sketch: sending is a few hundred bytes where the .taud was seventy thousand", () => {
  const s = sketchWithTune();
  const taud = sketchToTaud(s, bank).length;
  const mtsk = sketchToFile(s, bank).length;
  assert.ok(taud > 60000, `.taud ${taud}`);
  assert.ok(mtsk < 600, `.mtsk ${mtsk}`);
});

test("sketch: A-ak and Hyang-ak are Shi'er lü at their own reference pitch", () => {
  for (const [id, freq] of [["aak", 262], ["hyangak", 311]]) {
    const s = sketchWithTune();
    s.tuning = id;
    const song = parseTaud(sketchToTaud(s, bank));
    assert.equal(song.meta.songMeta[0].notation, 10123, `${id}: Shi'er lü notation`);
    assert.equal(song.songs[0].tuningBaseNote, 0x5000, `${id}: the declaration names C4`);
    assert.equal(song.songs[0].tuningFreq, freq);
  }
  assert.equal(tuningById("nonsense").id, "12");
  assert.deepEqual(TUNINGS.map((t) => t.id), [
    "4", "5", "6", "7", "8", "9", "10", "12", "15", "16", "17", "19", "22", "24", "31", "41", "43", "53", "bp", "aak", "hyangak",
  ]);
});

test("keyboard: the octave control means an octave, even where the period is not one", () => {
  const twelve = pitchTablePresets[120], bp = pitchTablePresets[35130];
  assert.equal(originPeriod(twelve, 3), -1);
  assert.equal(noteForDegree(4 + originPeriod(twelve, 3), 0, twelve), 0x4000, "C3");
  // A tritave is ~1.58 octaves: three octaves down is nearest two tritaves down.
  assert.equal(originPeriod(bp, 1), -2);
  assert.equal(originPeriod(bp, 4), 0);
});

// ── through the engine ───────────────────────────────────────────────────────

function rms(eng, seconds) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let sum = 0, n = 0;
  for (let i = 0; i < Math.ceil((seconds * SAMPLING_RATE) / TRACKER_CHUNK); i++) {
    eng.renderChunk(0, out);
    for (const b of out) { sum += (b - 128) ** 2; n++; }
  }
  return Math.sqrt(sum / n);
}

test("engine: a sketch plays, and an empty one is silent", () => {
  const eng = new TaudEngine();
  loadIntoEngine(eng, toTaudDoc(sketchWithTune(), bank));
  eng.setCuePosition(0, 0);
  eng.play(0);
  assert.ok(rms(eng, 1.5) > 2, "the tune is audible");

  const quiet = new TaudEngine();
  loadIntoEngine(quiet, toTaudDoc(newSketch(), bank));
  quiet.setCuePosition(0, 0);
  quiet.play(0);
  assert.ok(rms(quiet, 1) < 1, "nothing written, nothing heard");
});

test("engine: every preset sounds when jammed", () => {
  const eng = new TaudEngine();
  loadIntoEngine(eng, toTaudDoc(newSketch(), bank));
  for (let slot = 1; slot <= 15; slot++) {
    eng.jamNote(0, JAM_VOICE_BASE, 0x5000, slot);
    assert.ok(rms(eng, 0.25) > 1, `slot ${slot} (${bank.names[slot]}) is audible`);
    eng.jamStopVoice(0, JAM_VOICE_BASE);
    rms(eng, 0.05);
  }
});

test("engine: jamKeyOff releases a held note through its envelope instead of cutting it", () => {
  const eng = new TaudEngine();
  loadIntoEngine(eng, toTaudDoc(newSketch(), bank));
  const v = JAM_VOICE_BASE + 3;
  const voice = () => eng.playheads[0].trackerState.voices[v];

  eng.jamNote(0, v, 0x5000, bank.slots.pad);
  rms(eng, 2);
  assert.ok(voice().active, "a pad holds while the key is down");
  eng.jamKeyOff(0, v);
  assert.ok(voice().active && voice().keyOff, "released, not cut");
  const tail = rms(eng, 0.3);
  assert.ok(tail > 1, `the release is still sounding (${tail.toFixed(2)})`);
  rms(eng, 2);
  assert.equal(voice().active, false, "and it ends once the release has played");

  // A piano note decays by itself, and the key-off's fadeout finishes it.
  eng.jamNote(0, v, 0x5000, bank.slots.piano);
  rms(eng, 0.2);
  eng.jamKeyOff(0, v);
  rms(eng, 0.6);
  assert.equal(voice().active, false, "the fadeout ends a released piano note");
});

// ── note names ───────────────────────────────────────────────────────────────

test("notes: labels follow the tuning's own notation", () => {
  const at = (n, d, oct = 4) => noteLabel(noteForDegree(oct, d, pitchTablePresets[n]), pitchTablePresets[n]);
  assert.equal(at(120, 0), "C4");
  assert.equal(at(120, 1), "C♯4");
  assert.equal(at(120, 10, 3), "A♯3");
  assert.equal(at(240, 1), "C+4", "24-TET's half-sharp");
  assert.equal(at(240, 3), "Dd4", "…and half-flat");
  assert.equal(at(410, 1), "↑C4", "41-TET's Kite up-tick");
  assert.equal(noteLabel(NOTE_OFF, pitchTablePresets[120]), "off");
  assert.equal(at(10123, 0), "\u9EC34", "Shi'er lü's own names: 黃 (huangzhong)");
  assert.equal(at(35130, 7), "H4", "Bohlen–Pierce's H");
  const lu = pitchTablePresets[10123];
  const shade = (d) => noteShade(noteForDegree(4, d, lu), lu);
  // 黃 大 太 夾 姑 仲 蕤 林 夷 南 無 應, degrees 0…11.
  const W = "natural", G = "near", B = "accidental";
  assert.deepEqual([...Array(12).keys()].map(shade), [W, B, W, B, G, W, B, W, B, G, W, B],
    "Shi'er lü: white 黃 太 仲 林 無, grey 姑 南, black the rest");
  assert.equal(DRUMS.length, 8);
});

// ── the other end ────────────────────────────────────────────────────────────

test("tracker: Microtone's own document model opens a sent sketch", async () => {
  // A test-only reach into the tracker's tree: this is the contract a send
  // relies on, so it is checked against the code that will do the opening.
  const { Document } = await import("../../../microtone-worker/src/doc/document.js");
  const s = sketchWithTune();
  s.name = "Phone idea";
  s.tuning = "19";
  // …from the bytes that are sent, through the tracker's way in
  const sent = sketchFileToTaud(sketchToFile(s, bank));
  assert.deepEqual(sent, sketchToTaud(s, bank), "the tracker opens exactly what the phone played");
  const doc = new Document(parseTaud(sent));
  assert.equal(doc.channelCount, 32);
  assert.equal(doc.instrumentName(bank.slots.piano), "Piano");
  assert.equal(doc.instrumentName(bank.slots.drums[1]), "Snare");
  assert.ok(doc.usedInstrumentSlots().includes(bank.slots.piano));
  assert.equal(doc.meta.songMeta[0].notation, 190);
});
