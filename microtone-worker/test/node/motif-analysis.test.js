// The Motif editor's reading of a program (analysis.js): what each name refers
// to, Rename, the call hierarchy and the outline — and Preview's capture of
// what one call writes (build.js captureCall).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { analyze, planRename, isIdentifier } from "../../src/motif/analysis.js";
import { interpret, captureCall } from "../../src/motif/build.js";

const DEMO_TML = readFileSync(new URL("../../assets/demo_projects/Huygens_clock.tml", import.meta.url), "utf8");

/** The offset of the `n`th (0-based) `needle` in `src`. */
const at = (src, needle, n = 0) => {
  let i = -1;
  for (let k = 0; k <= n; k++) {
    i = src.indexOf(needle, i + 1);
    assert.ok(i >= 0, `"${needle}" #${n} is in the program`);
  }
  return i;
};
/** The places the name at `offset` is used, as [line text, write] pairs. */
const usesAt = (src, offset) => {
  const a = analyze(src);
  const o = a.occAt(offset);
  return o ? a.occurrencesOf(o.sym).map((u) => src.slice(u.start, u.end) + (u.write ? "=" : "") + "@" + u.start) : null;
};
/** Every lane's cells, as plain data, for comparing two programs' songs
 *  (by place, not by name: a lane's name is its label, and that is renamed too). */
const song = (src) => interpret(src).lanes.map((l) => [l.index, [...l.ev].map(([r, c]) => [r, { ...c, inst: c.inst?.slot }])]);

test("names resolve the way the interpreter resolves them", () => {
  const src = `tml 1
let x = 1
fn f(x) { return x + y }
let y = 2
{ let x = 3
  print(x) }
print(f(x), g())
fn g() { return x }
`;
  // the outer x: its let, the call's argument, and g's body (a function sees what its scope declares)
  assert.deepEqual(usesAt(src, at(src, "x")).map((u) => u.split("@")[0]), ["x=", "x", "x"]);
  assert.equal(usesAt(src, at(src, "x")).length, 3);
  // f's parameter shadows it inside f
  assert.deepEqual(usesAt(src, at(src, "x", 1)).map((u) => +u.split("@")[1]), [at(src, "x", 1), at(src, "x", 2)]);
  // a block's let is the block's own
  assert.deepEqual(usesAt(src, at(src, "x", 3)).map((u) => +u.split("@")[1]), [at(src, "x", 3), at(src, "x", 4)]);
  // y is declared after f, but f runs later: f's y is the let
  assert.equal(usesAt(src, at(src, "y")).length, 2);
  // g is hoisted: the call above its declaration names it
  assert.equal(usesAt(src, at(src, "g()")).length, 2);
  // builtins are names too, with no declaration
  const a = analyze(src);
  const p = a.occAt(at(src, "print"));
  assert.equal(p.sym.kind, "builtin");
  assert.equal(a.occurrencesOf(p.sym).length, 2);
});

test("a compound assignment is one place, a write", () => {
  const src = "tml 1\nlet total = 0\nfor i in range(3) { total += i }\nprint(total)\n";
  const a = analyze(src);
  const uses = a.occurrencesOf(a.occAt(at(src, "total")).sym);
  assert.deepEqual(uses.map((u) => [u.start, u.write]), [[at(src, "total"), true], [at(src, "total", 1), true], [at(src, "total", 2), false]]);
});

test("named arguments and record shorthands name what they name", () => {
  const src = `tml 1
fn pad(note, gain = 0) { return [note, gain] }
let gain = 3
print(pad("C4", gain: gain), { gain })
`;
  const a = analyze(src);
  // `gain:` names pad's parameter; the value after it is the let
  const param = a.occAt(at(src, "gain")).sym;
  assert.equal(param.kind, "parameter");
  assert.deepEqual(a.occurrencesOf(param).map((u) => u.start), [at(src, "gain"), at(src, "gain]"), at(src, "gain:")]);
  const v = a.occAt(at(src, "gain = 3")).sym;
  assert.equal(v.kind, "variable");
  assert.deepEqual(a.occurrencesOf(v).map((u) => u.start), [at(src, "gain = 3"), at(src, "gain)"), at(src, "gain }")]);
});

test("rename changes every use and nothing else", () => {
  const src = "tml 1\nlet total = 0\nfor i in range(3) { total += i }\nlet r = { total }\nprint(total, r.total, \"total\")\n";
  const r = planRename(src, at(src, "total"), "sum");
  assert.equal(r.count, 4);
  // the shorthand keeps its field, the field access and the string are not the variable
  assert.equal(r.source, "tml 1\nlet sum = 0\nfor i in range(3) { sum += i }\nlet r = { total: sum }\nprint(sum, r.total, \"total\")\n");
  // from any use, not only the declaration
  assert.equal(planRename(src, at(src, "total", 2) + 2, "sum").source, r.source);
});

test("rename refuses what would change the program's meaning", () => {
  const src = `tml 1
let a = 1
let b = 2
fn f(n) { return n + b }
print(a, f(a))
`;
  assert.deepEqual(planRename(src, at(src, "a"), "b"), { error: "conflict", name: "b", line: 3 });
  // a parameter called b would capture f's b
  assert.equal(planRename(src, at(src, "n)"), "b").error, "conflict");
  assert.equal(planRename(src, at(src, "n)"), "m").source, src.replace("f(n) { return n", "f(m) { return m"));
  assert.equal(planRename(src, at(src, "a"), "print").error, "conflict"); // would hide the builtin
  assert.equal(planRename(src, at(src, "print"), "show").error, "builtin");
  assert.equal(planRename(src, at(src, "a"), "let").error, "badName");
  assert.equal(planRename(src, at(src, "a"), "2a").error, "badName");
  assert.equal(planRename(src, at(src, "1"), "x").error, "notName");
  assert.equal(planRename(src + "print(\n", at(src, "a"), "x").error, "parse");
  assert.ok(isIdentifier("_x9") && !isIdentifier("fn") && !isIdentifier("9x") && !isIdentifier("a-b"));
});

test("Huygens' Clock renamed is the same song", () => {
  // a function, a parameter used by name and a lane, each renamed in turn
  const f = planRename(DEMO_TML, DEMO_TML.search(/\bfn \w/) + 3, "renamed_fn");
  assert.ok(f.count >= 2, `a function renamed in ${f.count} places`);
  const l = planRename(f.source, f.source.search(/^lane \w/m) + 5, "renamed_lane");
  assert.ok(!l.error && l.count >= 2, `a lane renamed in ${l.count} places`);
  assert.deepEqual(song(l.source), song(DEMO_TML));
});

test("the call hierarchy: who calls what, from where", () => {
  const src = `tml 1
fn leaf() { return 1 }
fn mid() { return leaf() + leaf() }
fn top() { return mid() + count(3) }
fn count(n) { return if n <= 0 then 0 else count(n - 1) }
print(top(), leaf())
`;
  const a = analyze(src);
  const sym = (name) => a.symbols.find((s) => s.name === name && s.kind === "function");
  const callers = (name) => a.callers(sym(name)).map((g) => [g.fn?.name ?? null, g.sites.length]);
  const callees = (name) => a.callees(sym(name)).map((g) => [g.fn.name, g.sites.length]);
  assert.deepEqual(callers("leaf"), [["mid", 2], [null, 1]]);
  assert.deepEqual(callees("mid"), [["leaf", 2]]);
  assert.deepEqual(callees("top"), [["mid", 1], ["count", 1]]);
  assert.deepEqual(callers("count"), [["top", 1], ["count", 1]]); // recursion is a caller of itself
  assert.deepEqual(callers("top"), [[null, 1]]);
  // builtins have callers
  const print = a.occAt(at(src, "print")).sym;
  assert.deepEqual(a.callers(print).map((g) => g.fn), [null]);
  // the call at an offset: the innermost one that holds it
  assert.equal(a.callAt(at(src, "leaf())")).name, "leaf");
  assert.equal(a.callAt(at(src, "top()", 1) + 1).name, "top");
  assert.equal(a.callAt(at(src, "print") + 2).name, "print");
});

test("the outline", () => {
  const src = `tml 1
song { title: "Out", bars: 4, tuning: "12-TET" }
instrument P { bank: 0, program: 0 }
lane a { inst: P }
section "A" 1..2
fn outer(x) { fn inner() { return x }; return inner() }
let [p, q] = [1, 2]
`;
  const s = analyze(src).structure;
  assert.deepEqual(s.map((i) => [i.kind, i.name, i.detail]), [
    ["song", "Out", "12-TET"], ["instrument", "P", "soundfont"], ["lane", "a", "P"],
    ["section", "A", "1..2"], ["function", "outer", "(x)"], ["variable", "p", ""], ["variable", "q", ""],
  ]);
  assert.deepEqual(s[4].children.map((i) => i.name), ["inner"]);
  assert.equal(src.slice(s[1].start, s[1].start + 1), "P");
  assert.equal(analyze("tml 1\nlet = 2\n").ok, false);
});

test("Preview captures what one call writes, every time it runs", () => {
  const src = `tml 1
song { title: "Cap", bars: 2, bar_rows: 8, tuning: "12-TET" }
instrument P { bank: 0, program: 0 }
lane a { inst: P }
lane b { inst: P }
fn beat(row) { hit(b, row, 'C4', 40) }
hit(a, 0, 'E4', 50)
for bar in 0..<2 { beat(bar * 8 + 4) }
`;
  // a call inside a loop: every iteration
  const c = captureCall(src, at(src, "beat(bar"));
  assert.deepEqual(c.lanes.map((l) => l.id), ["b"]);
  assert.deepEqual(c.lanes[0].cells.map(([r, x]) => [r, x.vol, c.names[x.note]]), [[4, 40, "C4"], [12, 40, "C4"]]);
  assert.equal(c.first, 4);
  assert.equal(c.last, 12);
  assert.deepEqual(c.instruments, [{ id: c.lanes[0].cells[0][1].instId, kind: "sf2", slot: 1 }]);
  // the call inside the function: the same, from the function's side
  assert.deepEqual(captureCall(src, at(src, "hit(b")).lanes[0].cells.length, 2);
  // a call that writes nothing
  assert.equal(captureCall(src, at(src, "0..<2")).first, null);
  // the top-level hit
  const t = captureCall(src, at(src, "hit(a"));
  assert.deepEqual(t.lanes.map((l) => [l.id, l.cells.length]), [["a", 1]]);
  assert.equal(t.song.barRows, 8);
});
