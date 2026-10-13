// Motif (item 208): the Taud Motif Language itself — syntax, values, control
// flow, errors that point at the source, and the sandbox (a program can only
// reach its builtins, and runs on a budget).

import { test } from "node:test";
import assert from "node:assert/strict";

import { interpret } from "../../src/motif/build.js";
import { MotifError } from "../../src/motif/lexer.js";
import { mulberry32 } from "../../src/motif/stdlib.js";
import { makeSeededRandom } from "../../core/engine/rng.js";

/** Run `body` (with the header added) and return what it printed. */
function out(body, opts = {}) {
  const lines = [];
  interpret(`tml 1\n${body}`, { ...opts, log: (l) => lines.push(l) });
  return lines.join("\n");
}
/** The MotifError `body` raises. */
function err(body, opts = {}) {
  try { out(body, opts); } catch (e) {
    if (e instanceof MotifError) return e;
    throw e;
  }
  assert.fail("expected a MotifError");
}

test("arithmetic and precedence", () => {
  assert.equal(out("print(1 + 2 * 3, (1 + 2) * 3, 2 ** 3 ** 2, -2 ** 2, 7 / 2)"), "7 9 512 -4 3.5");
  // % is floored: the sign follows the divisor, so pitch classes never go negative
  assert.equal(out("print(7 % 3, -7 % 3, 7 % -3, -32 % 31)"), "1 2 -2 30");
  // bitwise binds tighter than comparison (as in Python), and $ is hex
  assert.equal(out("print(5 & 3 == 1, $7300 | $0080, 1 << 4, $FF >> 4, ~0)"), "true 29568 16 15 -1");
  assert.equal(out("print(not 1 == 2, 1 < 2 and 2 < 3, false or none, 0 or \"x\")"), "true true none x");
});

test("strings: escapes, interpolation, triple quotes", () => {
  assert.equal(out('print("a\\tb\\u{263A}\\u00e9 \\${x}")'), "a\tb☺é ${x}");
  assert.equal(out('let n = 3\nprint("${n} × ${n + 1} = ${n * (n + 1)}; ${[1, "two"]}")'), '3 × 4 = 12; [1, "two"]');
  // the closing quotes' indentation is taken off every line, and the line
  // breaks after the opening and before the closing quotes are not text
  const s = out('fn f() {\n  return """\n    one\n\n      two ${1 + 1}\n    """\n}\nprint(f())');
  assert.equal(s, "one\n\n  two 2");
  assert.equal(out('print("""inline""")'), "inline");
  assert.equal(out('print(replace("Fp5 D5 Fp5", "Fp5", "F#5"), split("a  b c"), join([1, 2], "-"))'), 'F#5 D5 F#5 ["a", "b", "c"] 1-2');
});

test("lists, records, ranges", () => {
  assert.equal(out("let xs = [10, 20, 30, 40]\nxs[1] = 21\npush(xs, 50)\nprint(xs[-1], xs[1..2], xs[1..<3], len(xs))"), "50 [21, 30] [21, 30] 5");
  assert.equal(out("print(list(1..4), list(0..<10 by 3), list(5..1), list(5..1 by -2), range(3))"), "[1, 2, 3, 4] [0, 3, 6, 9] [] [5, 3, 1] 0..<3");
  assert.equal(out("let name = \"x\"\nlet r = { a: 1, name\n b: [2] }\nr.c = 3\nr[\"a\"] += 1\nprint(r, keys(r), r.b[0])"), '{a: 2, name: "x", b: [2], c: 3} ["a", "name", "b", "c"] 2');
  // == compares structure
  assert.equal(out("print([1, {a: [2]}] == [1, {a: [2]}], {a: 1} == {a: 2}, 1..3 == 1..3)"), "true false true");
  assert.equal(out("print(sort([3, 1, 2]), sort([\"b\", \"a\"]), reverse([1, 2]), sum(1..10), max([4, 9, 2]), min(3, 1))"), '[1, 2, 3] ["a", "b"] [2, 1] 55 9 1');
  assert.equal(out("print(map([1, 2], fn(x) => x * 10), filter(1..6, fn(x) => x % 2 == 0), reduce([1, 2, 3], fn(a, b) => a + b, 0))"), "[10, 20] [2, 4, 6] 6");
  assert.equal(out("print([1, 2] * 2, \"ab\" * 3, [0] + [1], unique([1, 1, 2]), rotate([1, 2, 3], 1), zip([1, 2], [3, 4]))"), '[1, 2, 1, 2] ababab [0, 1] [1, 2] [2, 3, 1] [[1, 3], [2, 4]]');
});

test("functions: defaults, named arguments, closures, hoisting, recursion", () => {
  assert.equal(out("fn f(a, b = a * 2, c = 1) { return a + b + c }\nprint(f(1), f(1, 1), f(1, c: 10), f(a: 5))"), "4 3 13 16");
  assert.equal(out("print(fact(10))\nfn fact(n) { return if n <= 1 then 1 else n * fact(n - 1) }"), "3628800");
  assert.equal(out("fn counter() {\n  let n = 0\n  return fn() { n += 1\n return n }\n}\nlet c = counter()\nc()\nc()\nprint(c())"), "3");
  assert.equal(out("let k = 2\nlet times = fn(x) => x * k\nprint(times(21))"), "42");
});

test("control flow", () => {
  assert.equal(out("let s = []\nfor i, x in [\"a\", \"b\"] { push(s, \"${i}${x}\") }\nfor k, v in ({p: 1, q: 2}) { push(s, k + str(v)) }\nprint(s)"), '["0a", "1b", "p1", "q2"]');
  assert.equal(out("let s = []\nfor i in 1..10 {\n  if i == 3 { continue }\n  if i > 5 { break }\n  push(s, i)\n}\nprint(s)"), "[1, 2, 4, 5]");
  assert.equal(out("let i = 0\nwhile i < 5 { i += 2 }\nprint(i)"), "6");
  // else may start the line after the closing brace
  assert.equal(out("for n in [1, 5, 9] {\n  if n < 3 { print(\"low\") }\n  else if n < 6 { print(\"mid\") }\n  else { print(\"high\") }\n}"), "low\nmid\nhigh");
  assert.equal(out("{\n  let x = 1\n  print(x)\n}\nlet x = 2\nprint(x)"), "1\n2");
  assert.equal(out("for [a, b] in [[1, 2], [3, 4]] { print(a + b) }"), "3\n7");
  // a long expression continues after an operator or inside brackets
  assert.equal(out("let t = 1 +\n  2\nlet u = (1\n  + 3)\nprint(t, u, [1,\n 2])"), "3 4 [1, 2]");
});

test("errors point at the line and column", () => {
  const e = err("let a = 1\nprint(b)");
  assert.equal(e.pos.line, 3);
  assert.match(e.message, /"b" is not defined/);
  assert.match(err("print(1 + \"x\")").message, /cannot add number and string/);
  assert.match(err("let a = 1\nlet a = 2").message, /already defined/);
  assert.match(err("print(len)\nlen = 3").message, /built in and cannot be changed/);
  assert.match(err("fn f(a) { return a }\nf(1, 2)").message, /at most 1 argument/);
  assert.match(err("fn f(a) { return a }\nf(b: 2)").message, /no parameter "b"/);
  assert.match(err("break").message, /outside a loop/);
  assert.match(err("return 1").message, /outside a function/);
  assert.match(err("let xs = [1]\nprint(xs[3])").message, /outside the list/);
  assert.match(err("print({a: 1}.b)").message, /no field "b"/);
  assert.match(err("if 1 < 2 < 3 { }").message, /do not chain/);
  assert.match(err('print("open').message, /never closed/);
  // a runtime error inside a call carries the TML call stack
  const t = err("fn inner(x) { return x.y }\nfn outer() { return inner(1) }\nouter()");
  assert.deepEqual(t.trace.map((f) => f.name), ["inner", "outer"]);
});

test("the header: tml and its version", () => {
  assert.throws(() => interpret("print(1)"), /starts with the language version/);
  assert.throws(() => interpret("tml 2\n"), /TML 2; this version of Microtone reads TML 1/);
});

test("the sandbox: a budget of steps, a bounded depth, bounded sizes", () => {
  assert.match(err("while true { }", { steps: 10000 }).message, /more than 10,000 steps/);
  assert.match(err("fn f(n) { return f(n + 1) }\nf(0)").message, /nest more than 200 deep/);
  assert.match(err("let xs = repeat(0, 2000000)").message, /longer than the limit/);
  assert.match(err("let s = \"ab\" * 1000000").message, /longer than the limit/);
  // nothing of the host is in reach
  for (const name of ["globalThis", "window", "eval", "Function", "require", "process", "constructor", "Math"]) {
    assert.match(err(`print(${name})`).message, /is not defined/, name);
  }
  // record keys are plain data, whatever they are called
  assert.equal(out('let r = {constructor: 1}\nr["__proto__"] = 2\nprint(r.constructor, r["__proto__"], keys(r))'), '1 2 ["constructor", "__proto__"]');
  assert.match(err("print(len.fields)").message, /function has no field/);
});

test("randomness is seeded: the same seed, the same song", () => {
  const a = out("seed(7)\nprint(random(), random_int(1, 6), choose([1, 2, 3]), shuffle(1..5), chance(0.5))");
  const b = out("seed(7)\nprint(random(), random_int(1, 6), choose([1, 2, 3]), shuffle(1..5), chance(0.5))");
  assert.equal(a, b);
  assert.notEqual(a, out("seed(8)\nprint(random(), random_int(1, 6), choose([1, 2, 3]), shuffle(1..5), chance(0.5))"));
  // the stream is Mulberry32, as the spec says (and as the engine's tests seed with)
  const m = mulberry32(1), r = makeSeededRandom(1);
  for (let i = 0; i < 20; i++) assert.equal(m(), r());
  // noise(a, b) is a fixed hash: lane jitter's
  assert.equal(out("print(noise(3, 10) == noise(3, 10), noise(3, 10) != noise(3, 11))"), "true true");
});
