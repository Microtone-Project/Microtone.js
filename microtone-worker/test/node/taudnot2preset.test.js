// tools/taudnot2preset.js — a .taudnot printed as a built-in preset entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildTaudnot, parseTaudnot, defToPreset } from "../../src/doc/notation.js";
import { pitchTablePresets, resolveNoteSymbol, ANCHOR_NOTE, finePreset } from "../../core/tuning/pitchtables.js";
import { presetLine, insertPreset } from "../../tools/taudnot2preset.js";

const SRC = readFileSync(fileURLToPath(new URL("../../core/tuning/pitchtables.js", import.meta.url)), "utf8");
const lineOf = (index) => SRC.split("\n").find((l) => l.startsWith(`  ${index}: {`));

/** A preset through a .taudnot and back, as the tool prints it. */
function roundTrip(p) {
  // One stated at 65536-TET goes out as its fine view, as the Notation Maker saved it.
  const f = p.exactInterval !== undefined ? finePreset(p) : p;
  const def = { slot: 0, interval: f.interval, base: p.base ?? 0, name: p.name, table: f.table, syms: p.sym };
  const back = defToPreset(parseTaudnot(buildTaudnot([def]))[0]);
  return presetLine({ index: p.index, name: back.name, table: back.table, interval: back.interval,
    exact: back.exact, exactInterval: back.exactInterval, base: back.base, t: p.t, sym: back.sym });
}

test("every literal built-in preset prints back as its own source line", () => {
  // Spelt from a shared constant (SYM_12/24/96), multi-line (ProTracker), or
  // carrying a two-character token the codec completes (15-TET's " F").
  const skip = new Set([0, 1, 120, 150, 240, 960, 10121, 10122]);
  const checked = [];
  for (const p of Object.values(pitchTablePresets)) {
    if (skip.has(p.index)) continue;
    assert.equal(roundTrip(p), lineOf(p.index), `preset ${p.index}`);
    checked.push(p.index);
  }
  assert.ok(checked.includes(360) && checked.includes(10123), "Kite 36 and Shi'er lü's escapes covered");
  assert.ok(checked.includes(20780), "a period stated at 65536-TET covered");
});

test("the Carlos scales keep their 65536-TET periods: equal steps of a stretched octave", () => {
  // [index, degrees, step in cents, period in 65536-TET units, as the .taudnot stated it]
  for (const [index, n, cents, period] of [[20780, 16, 78.0, 68157], [20638, 19, 63.8, 66202], [20351, 35, 35.1, 67092]]) {
    const p = pitchTablePresets[index], f = finePreset(p);
    assert.equal(p.table.length, n, `${index}`);
    assert.equal(f.interval * 16, period, `${index}: the period keeps its fraction`);
    assert.equal(p.interval, Math.round(period / 16), `${index}: the 4096-TET form is the rounded period`);
    f.table.forEach((v, i) => assert.equal(v * 16, Math.round((i * period) / n), `${index} degree ${i}`));
    p.table.forEach((v, i) => assert.equal(v, Math.round(f.table[i]), `${index} degree ${i}, whole units`));
    assert.ok(Math.abs((f.interval / n) * 1200 / 4096 - cents) < 0.001, `${index}: a ${cents}-cent step`);
  }
});

test("36-TET (Kite) is an equal division spelt Kite's way", () => {
  const p = pitchTablePresets[360];
  assert.equal(p.name, "36-TET (Kite)");
  assert.equal(p.table.length, 36);
  p.table.forEach((v, i) => assert.equal(v, Math.round((i * 0x1000) / 36), `degree ${i}`));
  assert.equal(p.sym.length, 36);
  // unmarked degrees are the big dot (never blank), every 3rd degree a 12-TET note
  for (let i = 0; i < 36; i += 3) assert.equal(p.sym[i][0], ".", `degree ${i}`);
  assert.equal(resolveNoteSymbol(ANCHOR_NOTE, p).tick, ".");
  assert.equal(resolveNoteSymbol(ANCHOR_NOTE + p.table[1], p).tick, "u");
});

test("insertPreset keeps the keys ascending and refuses a taken index", () => {
  const p = { ...pitchTablePresets[360], index: 370, name: "test" };
  const out = insertPreset(SRC, p, false);
  const keys = [...out.matchAll(/^ {2}(\d+): \{/gm)].map((m) => Number(m[1]));
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  assert.ok(keys.includes(370));
  assert.throws(() => insertPreset(SRC, { ...p, index: 360 }, false), /already exists/);
  // --replace swaps exactly that entry, multi-line ProTracker included
  const pt = insertPreset(SRC, { ...p, index: 1 }, true);
  assert.equal(pt.split("\n").length, SRC.split("\n").length - (lineCount(1) - 1));
  assert.equal(insertPreset(SRC, pitchTablePresets[360], true), SRC);
});

function lineCount(index) {
  const lines = SRC.split("\n");
  const from = lines.findIndex((l) => l.startsWith(`  ${index}: {`));
  let to = from + 1;
  while (!/^ {2}\d+: \{/.test(lines[to])) to++;
  return to - from;
}
