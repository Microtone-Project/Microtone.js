// Taud Motif Language (TML) — values. What a TML program computes with: number
// (a double), string, bool, none (null), list (a JS array), record (Rec),
// function (Closure / Builtin), range (Range), phrase (Phrase: music, in TML 2)
// and the opaque handles a host adds (a lane, an instrument), which expose
// read-only fields. Plus the checks every builtin uses to turn a wrong type
// into a sentence.

import { MotifError } from "./lexer.js";

export { MotifError };

export const DEFAULT_STEPS = 50_000_000;
export const DEFAULT_DEPTH = 200;
export const MAX_ITEMS = 1_000_000;  // longest list or string a program may build

/** A record: string keys in the order they were first written. */
export class Rec {
  constructor(entries = null) { this.m = new Map(entries ?? []); }
}
export class Range {
  constructor(from, to, step, inclusive) {
    this.from = from; this.to = to; this.step = step; this.inclusive = inclusive;
  }
  get length() {
    const { from, to, step, inclusive } = this;
    const span = to - from;
    if (step > 0 ? span < 0 : span > 0) return 0;
    let n = Math.floor(span / step) + 1;
    if (!inclusive && from + (n - 1) * step === to) n--;
    return Math.max(0, n);
  }
  at(i) { return this.from + i * this.step; }
}
export class Closure {
  constructor(name, params, body, expr, scope) {
    this.name = name; this.params = params; this.body = body; this.expr = expr; this.scope = scope;
  }
}
export class Builtin {
  /** `spec` lists the parameters: "lane, row, vol=none, ...rest". */
  constructor(name, spec, fn) {
    this.name = name;
    this.fn = fn;
    this.params = [];
    this.rest = null;
    for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (raw.startsWith("...")) { this.rest = raw.slice(3); continue; }
      const eq = raw.indexOf("=");
      if (eq < 0) this.params.push({ name: raw, required: true });
      else this.params.push({ name: raw.slice(0, eq), required: false, def: parseDefault(raw.slice(eq + 1)) });
    }
  }
}
function parseDefault(s) {
  if (s === "none") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("\"")) return s.slice(1, -1);
  throw new Error(`bad builtin default ${s}`);
}

/** A host value with read-only fields (a lane, an instrument). */
export class Handle {
  constructor(kind, fields) { this.kind = kind; this.fields = fields; }
}

/**
 * Music as a value (TML 2): the cells a phrase writes, by lane and row, and its
 * fitted parts — the ones that can only be placed once the whole song is known
 * (a vibrato that steps round effects, music under() the rest). It spans the
 * rows [from, to). A phrase never changes; phrase.js makes new ones.
 */
export class Phrase {
  /**
   * @param cells  Map lane → Map row → cell (the fields a row writes)
   * @param soft   [{lane, self, gen(view, interp) → Phrase | null, cap, pos, trace}]
   */
  constructor(cells, soft, from, to) {
    this.cells = cells;
    this.soft = soft;
    this.from = from;
    this.to = to;
  }
}

/** A TML 2 name whose value is computed the first time it is needed (the
 *  names of a block can be used before the line that defines them). */
export class Thunk {
  constructor(compute) { this.state = 0; this.value = undefined; this.compute = compute; }
}

// ── value helpers, shared with the music builtins ──

export function typeName(v) {
  if (v === null || v === undefined) return "none";
  switch (typeof v) {
    case "number": return "number";
    case "string": return "string";
    case "boolean": return "bool";
    default: break;
  }
  if (Array.isArray(v)) return "list";
  if (v instanceof Rec) return "record";
  if (v instanceof Range) return "range";
  if (v instanceof Closure || v instanceof Builtin) return "function";
  if (v instanceof Handle) return v.kind;
  if (v instanceof Phrase) return "phrase";
  return "value";
}

export function truthy(v) {
  return !(v === false || v === null || v === undefined || v === 0 || v === "" || Number.isNaN(v));
}

export function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Rec) {
    if (!(b instanceof Rec) || a.m.size !== b.m.size) return false;
    for (const [k, v] of a.m) if (!b.m.has(k) || !equal(v, b.m.get(k))) return false;
    return true;
  }
  if (a instanceof Range && b instanceof Range) {
    return a.from === b.from && a.step === b.step && a.length === b.length;
  }
  if (a instanceof Phrase && b instanceof Phrase) {
    // by what they place for certain, and the very same fitted parts
    if (a.from !== b.from || a.to !== b.to || a.soft.length !== b.soft.length) return false;
    if (a.soft.some((p, i) => p !== b.soft[i])) return false;
    const lanes = [...a.cells.keys()].filter((l) => a.cells.get(l).size);
    if (lanes.length !== [...b.cells.values()].filter((r) => r.size).length) return false;
    for (const l of lanes) {
      const x = a.cells.get(l), y = b.cells.get(l);
      if (!y || x.size !== y.size) return false;
      for (const [r, c] of x) {
        const d = y.get(r);
        if (!d) return false;
        const ka = Object.keys(c).filter((k) => k !== "cap"), kb = Object.keys(d).filter((k) => k !== "cap");
        if (ka.length !== kb.length || ka.some((k) => c[k] !== d[k])) return false;
      }
    }
    return true;
  }
  return false;
}

function fmtNumber(n) {
  if (Number.isInteger(n)) return String(n);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "nan" : n > 0 ? "inf" : "-inf";
  return String(Math.round(n * 1e9) / 1e9);
}

/** How a value reads inside "${…}" and in print(). */
export function show(v, nested = false) {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return nested ? JSON.stringify(v) : v;
  if (typeof v === "number") return fmtNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map((x) => show(x, true)).join(", ")}]`;
  if (v instanceof Rec) return `{${[...v.m].map(([k, x]) => `${k}: ${show(x, true)}`).join(", ")}}`;
  if (v instanceof Range) return `${v.from}..${v.inclusive ? "" : "<"}${v.to}${v.step !== 1 ? ` by ${v.step}` : ""}`;
  if (v instanceof Closure) return `fn ${v.name ?? "(anonymous)"}`;
  if (v instanceof Builtin) return `fn ${v.name}`;
  if (v instanceof Handle) return `${v.kind} ${v.fields.name ?? ""}`.trim();
  if (v instanceof Phrase) {
    let n = 0;
    const names = [];
    for (const [lane, rows] of v.cells) if (rows.size) { n += rows.size; names.push(lane.id); }
    const fitted = v.soft.length ? ` and ${v.soft.length} fitted part${v.soft.length === 1 ? "" : "s"}` : "";
    return `phrase of rows ${v.from}..<${v.to}: ${n} cell${n === 1 ? "" : "s"}${names.length ? ` on ${names.join(", ")}` : ""}${fitted}`;
  }
  return String(v);
}

export function fail(message) { return new MotifError(message); }

export function asNumber(v, what) {
  if (typeof v !== "number" || Number.isNaN(v)) throw fail(`${what} must be a number, not ${typeName(v)}`);
  return v;
}
export function asInt(v, what) {
  asNumber(v, what);
  if (!Number.isInteger(v)) throw fail(`${what} must be a whole number, not ${fmtNumber(v)}`);
  return v;
}
export function asString(v, what) {
  if (typeof v !== "string") throw fail(`${what} must be a string, not ${typeName(v)}`);
  return v;
}
export function asList(v, what) {
  if (v instanceof Range) return toList(v);
  if (!Array.isArray(v)) throw fail(`${what} must be a list, not ${typeName(v)}`);
  return v;
}
export function asRecord(v, what) {
  if (!(v instanceof Rec)) throw fail(`${what} must be a record, not ${typeName(v)}`);
  return v;
}
export function asFunction(v, what) {
  if (!(v instanceof Closure || v instanceof Builtin)) throw fail(`${what} must be a function, not ${typeName(v)}`);
  return v;
}
export function toList(r) {
  const n = r.length;
  if (n > MAX_ITEMS) throw fail(`a list of ${n} items is longer than the limit of ${MAX_ITEMS}`);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = r.at(i);
  return out;
}
export function checkSize(n) {
  if (n > MAX_ITEMS) throw fail(`a list or string of ${n} items is longer than the limit of ${MAX_ITEMS}`);
}

/** Every (key, value) a for-loop walks. */
export function* entriesOf(v) {
  if (Array.isArray(v)) { const snap = v.slice(); for (let i = 0; i < snap.length; i++) yield [i, snap[i]]; return; }
  if (v instanceof Range) { const n = v.length; for (let i = 0; i < n; i++) yield [i, v.at(i)]; return; }
  if (v instanceof Rec) { for (const [k, x] of [...v.m]) yield [k, x]; return; }
  if (typeof v === "string") { const cs = [...v]; for (let i = 0; i < cs.length; i++) yield [i, cs[i]]; return; }
  throw fail(`cannot loop over ${typeName(v)}`);
}
