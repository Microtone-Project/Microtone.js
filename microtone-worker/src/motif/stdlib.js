// The general builtins every TML program sees: numbers, lists, strings,
// records, randomness. The music builtins live in music.js. Every one of these
// is pure apart from the random stream (seeded, so a build is repeatable) and
// print (which only writes to the build log).

import {
  Builtin, Rec, Range, Closure, MotifError, asNumber, asInt, asString, asList, asRecord, asFunction,
  checkSize, equal, fail, show, toList, typeName, truthy,
} from "./values.js";

/**
 * Mulberry32 — the random stream behind random(), chance(), choose() and
 * shuffle(). Specified (TAUD_MOTIF_LANGUAGE.md §Randomness) so that the same
 * seed gives the same song in every implementation.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic noise in [−1, 1) for a pair of whole numbers: the same hash
 *  lane jitter uses (noise(lane index, row in pattern)). */
export function noise2(a, b) {
  let t = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}

function cmpValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw fail(`cannot sort ${typeName(a)} against ${typeName(b)}`);
}

function deepCopy(v) {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v instanceof Rec) return new Rec([...v.m].map(([k, x]) => [k, deepCopy(x)]));
  return v;
}

const math1 = (name, f) => new Builtin(name, "x", (_, x) => f(asNumber(x, `${name}()'s argument`)));

/**
 * @param state  {random: () => [0,1), reseed(n), log(line)} — what the random
 *               builtins and print() talk to
 */
export function stdlib(state) {
  const call = (interp, f, args) => interp.call(f, args, null, null);
  const fns = [
    // ── conversions and checks ──
    new Builtin("str", "x", (_, x) => show(x)),
    new Builtin("num", "x", (_, x) => {
      if (typeof x === "number") return x;
      const s = asString(x, "num()'s argument").trim();
      const v = /^\$[0-9a-f]+$/i.test(s) ? parseInt(s.slice(1), 16) : Number(s);
      if (s === "" || Number.isNaN(v)) throw fail(`"${s}" is not a number`);
      return v;
    }),
    new Builtin("type", "x", (_, x) => typeName(x)),
    new Builtin("error", "message", (_, m) => { throw fail(show(m)); }),
    new Builtin("assert", "condition, message=\"assertion failed\"", (_, c, m) => {
      if (!truthy(c)) throw fail(show(m));
    }),
    new Builtin("print", "...values", (interp, ...xs) => { state.log(xs.map((x) => show(x)).join(" ")); }),

    // ── numbers ──
    math1("abs", Math.abs), math1("floor", Math.floor), math1("ceil", Math.ceil),
    math1("trunc", Math.trunc), math1("sqrt", Math.sqrt), math1("sin", Math.sin),
    math1("cos", Math.cos), math1("tan", Math.tan), math1("asin", Math.asin),
    math1("acos", Math.acos), math1("atan", Math.atan), math1("exp", Math.exp),
    math1("log", Math.log), math1("log2", Math.log2), math1("log10", Math.log10),
    math1("sign", Math.sign),
    // halves round up (towards +∞), as a tracker's arithmetic always has
    math1("round", Math.round),
    new Builtin("atan2", "y, x", (_, y, x) => Math.atan2(asNumber(y, "y"), asNumber(x, "x"))),
    new Builtin("min", "...values", (_, ...xs) => extreme(xs, "min", Math.min)),
    new Builtin("max", "...values", (_, ...xs) => extreme(xs, "max", Math.max)),
    new Builtin("clamp", "x, lo, hi", (_, x, lo, hi) => Math.min(asNumber(hi, "hi"), Math.max(asNumber(lo, "lo"), asNumber(x, "x")))),
    new Builtin("db", "decibels", (_, d) => 10 ** (asNumber(d, "decibels") / 20)),

    // ── lists ──
    new Builtin("len", "x", (_, x) => {
      if (typeof x === "string") return [...x].length;
      if (Array.isArray(x)) return x.length;
      if (x instanceof Range) return x.length;
      if (x instanceof Rec) return x.m.size;
      throw fail(`${typeName(x)} has no length`);
    }),
    new Builtin("range", "a, b=none, step=1", (_, a, b, step) => {
      const s = asInt(step, "range()'s step");
      if (s === 0) throw fail("a range cannot step by 0");
      if (b === null) return new Range(0, asInt(a, "range()'s end"), s, false);
      return new Range(asInt(a, "range()'s start"), asInt(b, "range()'s end"), s, false);
    }),
    new Builtin("list", "x", (_, x) => {
      if (x instanceof Range) return toList(x);
      if (Array.isArray(x)) return x.slice();
      if (typeof x === "string") return [...x];
      if (x instanceof Rec) return [...x.m.keys()];
      throw fail(`cannot make a list from ${typeName(x)}`);
    }),
    new Builtin("repeat", "value, n", (_, v, n) => {
      asInt(n, "the repeat count");
      if (n < 0) throw fail("cannot repeat a negative number of times");
      checkSize(n);
      return Array.from({ length: n }, () => deepCopy(v));
    }),
    new Builtin("push", "list, ...values", (_, xs, ...vs) => {
      asList(xs, "push()'s list");
      checkSize(xs.length + vs.length);
      xs.push(...vs);
    }),
    new Builtin("pop", "list", (_, xs) => {
      if (!asList(xs, "pop()'s list").length) throw fail("pop() from an empty list");
      return xs.pop();
    }),
    new Builtin("insert", "list, index, value", (_, xs, i, v) => {
      asList(xs, "insert()'s list");
      asInt(i, "the index");
      const k = i < 0 ? xs.length + i : i;
      if (k < 0 || k > xs.length) throw fail(`index ${i} is outside the list (it has ${xs.length} items)`);
      checkSize(xs.length + 1);
      xs.splice(k, 0, v);
    }),
    new Builtin("remove", "list, index", (_, xs, i) => {
      asList(xs, "remove()'s list");
      asInt(i, "the index");
      const k = i < 0 ? xs.length + i : i;
      if (k < 0 || k >= xs.length) throw fail(`index ${i} is outside the list (it has ${xs.length} items)`);
      return xs.splice(k, 1)[0];
    }),
    new Builtin("slice", "xs, from, to=none", (_, xs, a, b) => {
      if (!(Array.isArray(xs) || typeof xs === "string")) throw fail(`cannot slice ${typeName(xs)}`);
      return xs.slice(asInt(a, "the start"), b === null ? undefined : asInt(b, "the end"));
    }),
    new Builtin("reverse", "xs", (_, xs) => {
      if (typeof xs === "string") return [...xs].reverse().join("");
      return asList(xs, "reverse()'s argument").slice().reverse();
    }),
    new Builtin("rotate", "xs, n", (_, xs, n) => {
      const l = asList(xs, "rotate()'s list");
      if (!l.length) return [];
      const k = ((asInt(n, "the rotation") % l.length) + l.length) % l.length;
      return l.slice(k).concat(l.slice(0, k));
    }),
    new Builtin("sort", "xs, key=none", (interp, xs, key) => {
      const l = asList(xs, "sort()'s list").slice();
      if (key === null) return l.sort(cmpValues);
      asFunction(key, "sort()'s key");
      const keyed = l.map((v, i) => [call(interp, key, [v]), i, v]);
      keyed.sort((p, q) => cmpValues(p[0], q[0]) || p[1] - q[1]);
      return keyed.map((p) => p[2]);
    }),
    new Builtin("map", "xs, f", (interp, xs, f) => {
      asFunction(f, "map()'s function");
      return asList(xs, "map()'s list").map((v, i) => call(interp, f, f instanceof Closure && f.params.length >= 2 ? [v, i] : [v]));
    }),
    new Builtin("filter", "xs, f", (interp, xs, f) => {
      asFunction(f, "filter()'s function");
      return asList(xs, "filter()'s list").filter((v) => truthy(call(interp, f, [v])));
    }),
    new Builtin("reduce", "xs, f, initial", (interp, xs, f, init) => {
      asFunction(f, "reduce()'s function");
      let acc = init;
      for (const v of asList(xs, "reduce()'s list")) acc = call(interp, f, [acc, v]);
      return acc;
    }),
    new Builtin("sum", "xs", (_, xs) => asList(xs, "sum()'s list").reduce((s, v) => s + asNumber(v, "an item of sum()'s list"), 0)),
    new Builtin("any", "xs, f=none", (interp, xs, f) => asList(xs, "any()'s list").some((v) => truthy(f === null ? v : call(interp, f, [v])))),
    new Builtin("all", "xs, f=none", (interp, xs, f) => asList(xs, "all()'s list").every((v) => truthy(f === null ? v : call(interp, f, [v])))),
    new Builtin("contains", "xs, x", (_, xs, x) => {
      if (typeof xs === "string") return xs.includes(asString(x, "the text to find"));
      if (xs instanceof Rec) return xs.m.has(asString(x, "the key"));
      return asList(xs, "contains()'s collection").some((v) => equal(v, x));
    }),
    new Builtin("index_of", "xs, x", (_, xs, x) => {
      if (typeof xs === "string") return xs.indexOf(asString(x, "the text to find"));
      return asList(xs, "index_of()'s list").findIndex((v) => equal(v, x));
    }),
    new Builtin("count", "xs, x", (_, xs, x) => asList(xs, "count()'s list").filter((v) => equal(v, x)).length),
    new Builtin("unique", "xs", (_, xs) => {
      const out = [];
      for (const v of asList(xs, "unique()'s list")) if (!out.some((u) => equal(u, v))) out.push(v);
      return out;
    }),
    new Builtin("flatten", "xs", (_, xs) => {
      const out = [];
      for (const v of asList(xs, "flatten()'s list")) Array.isArray(v) ? out.push(...v) : out.push(v);
      checkSize(out.length);
      return out;
    }),
    new Builtin("zip", "a, b", (_, a, b) => {
      const x = asList(a, "zip()'s first list"), y = asList(b, "zip()'s second list");
      return Array.from({ length: Math.min(x.length, y.length) }, (_v, i) => [x[i], y[i]]);
    }),
    new Builtin("copy", "x", (_, x) => deepCopy(x)),

    // ── strings ──
    new Builtin("split", "s, sep=none", (_, s, sep) => {
      const t = asString(s, "split()'s text");
      if (sep === null) return t.trim() ? t.trim().split(/\s+/) : [];
      return t.split(asString(sep, "the separator"));
    }),
    new Builtin("join", "xs, sep=\"\"", (_, xs, sep) => asList(xs, "join()'s list").map((v) => show(v)).join(asString(sep, "the separator"))),
    new Builtin("replace", "s, find, with", (_, s, a, b) => {
      const t = asString(s, "replace()'s text");
      const out = t.split(asString(a, "the text to find")).join(asString(b, "the replacement"));
      checkSize(out.length);
      return out;
    }),
    new Builtin("trim", "s", (_, s) => asString(s, "trim()'s text").trim()),
    new Builtin("upper", "s", (_, s) => asString(s, "upper()'s text").toUpperCase()),
    new Builtin("lower", "s", (_, s) => asString(s, "lower()'s text").toLowerCase()),
    new Builtin("starts_with", "s, prefix", (_, s, p) => asString(s, "the text").startsWith(asString(p, "the prefix"))),
    new Builtin("ends_with", "s, suffix", (_, s, p) => asString(s, "the text").endsWith(asString(p, "the suffix"))),

    // ── records ──
    new Builtin("keys", "r", (_, r) => [...asRecord(r, "keys()'s record").m.keys()]),
    new Builtin("values", "r", (_, r) => [...asRecord(r, "values()'s record").m.values()]),
    new Builtin("has_key", "r, key", (_, r, k) => asRecord(r, "has_key()'s record").m.has(asString(k, "the key"))),
    new Builtin("get", "r, key, default=none", (_, r, k, d) => {
      const m = asRecord(r, "get()'s record").m;
      const key = asString(k, "the key");
      return m.has(key) ? m.get(key) : d;
    }),
    new Builtin("merge", "a, b", (_, a, b) => new Rec([...asRecord(a, "merge()'s first record").m, ...asRecord(b, "merge()'s second record").m])),

    // ── randomness (seeded: the same seed builds the same song) ──
    new Builtin("seed", "n", (_, n) => { state.reseed(asInt(n, "the seed")); }),
    new Builtin("random", "", () => state.random()),
    new Builtin("random_int", "lo, hi", (_, lo, hi) => {
      const a = asInt(lo, "the low end"), b = asInt(hi, "the high end");
      if (b < a) throw fail("random_int(lo, hi) needs lo ≤ hi");
      return a + Math.floor(state.random() * (b - a + 1));
    }),
    new Builtin("chance", "p", (_, p) => state.random() < asNumber(p, "the probability")),
    new Builtin("choose", "xs", (_, xs) => {
      const l = asList(xs, "choose()'s list");
      if (!l.length) throw fail("choose() from an empty list");
      return l[Math.floor(state.random() * l.length)];
    }),
    new Builtin("choose_weighted", "xs, weights", (_, xs, ws) => {
      const l = asList(xs, "choose_weighted()'s list"), w = asList(ws, "the weights");
      if (!l.length || l.length !== w.length) throw fail("choose_weighted() needs as many weights as items, and at least one");
      const total = w.reduce((s, v) => s + Math.max(0, asNumber(v, "a weight")), 0);
      if (!(total > 0)) throw fail("choose_weighted() needs a positive weight");
      let r = state.random() * total;
      for (let i = 0; i < l.length; i++) { r -= Math.max(0, w[i]); if (r < 0) return l[i]; }
      return l[l.length - 1];
    }),
    new Builtin("shuffle", "xs", (_, xs) => {
      const l = asList(xs, "shuffle()'s list").slice();
      for (let i = l.length - 1; i > 0; i--) {
        const j = Math.floor(state.random() * (i + 1));
        [l[i], l[j]] = [l[j], l[i]];
      }
      return l;
    }),
    new Builtin("noise", "a, b=0", (_, a, b) => noise2(asInt(a, "noise()'s first number"), asInt(b, "noise()'s second number"))),
  ];
  const out = new Map(fns.map((f) => [f.name, f]));
  out.set("PI", Math.PI);
  return out;
}

function extreme(xs, name, f) {
  const l = xs.length === 1 && (Array.isArray(xs[0]) || xs[0] instanceof Range) ? asList(xs[0], name) : xs;
  if (!l.length) throw new MotifError(`${name}() of nothing`);
  return f(...l.map((v) => asNumber(v, `an argument of ${name}()`)));
}
