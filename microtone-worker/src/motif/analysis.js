// What a TML program's names refer to — the editor's view of it, without
// running it. From the syntax tree: every declaration (a let, a function, a
// parameter, a loop variable, a lane, an instrument) and every place each one
// is named, every call and the function it sits in, and an outline of the
// program. The Motif view builds its occurrence highlights, Rename, the
// Structure panel and the call hierarchy on this.
//
// Names resolve the way the interpreter resolves them (interp.js): a block —
// an if's or a while's branch, a bare { } — is a scope of its own; a loop's
// variables share a scope with its body, and a function's parameters with its
// body; a named function is visible from the top of its block; a let, a lane
// and an instrument from the end of their own statement on — and from inside
// any function written in their scope, which runs later.

import { parse } from "./parser.js";
import { BUILTIN_NAMES } from "./highlight.js";

const KEYWORDS = new Set([
  "tml", "let", "fn", "for", "in", "while", "if", "then", "else", "return", "break",
  "continue", "and", "or", "not", "true", "false", "none",
]);

/** Can `name` be a TML name? */
export function isIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name);
}

class AScope {
  constructor(parent, fn = false, start = 0, end = Infinity) {
    this.parent = parent;
    this.fn = fn;          // a function's own scope (a closure boundary)
    this.decls = new Map();
    this.start = start;
    this.end = end;
  }
}

/**
 * Analyse a program. Never throws: a program that does not parse comes back as
 * {ok: false, error} — the editor keeps what it had until it parses again.
 */
export function analyze(source) {
  let ast;
  try { ast = parse(source); } catch (error) { return { ok: false, error }; }
  const a = new Analyzer(source);
  a.program(ast);
  return a.result();
}

class Analyzer {
  constructor(source) {
    this.source = source;
    this.symbols = [];
    this.occ = [];
    this.calls = [];
    this.pendingNamed = []; // named arguments, resolved once every function is known
    this.builtins = new Map();
    this.encl = [];         // the named functions being walked, innermost last
    this.structure = [];
    this.dups = [];         // names declared twice in one scope
  }

  sym(name, kind, pos, extra = {}) {
    const s = { id: this.symbols.length, name, kind, start: pos.offset, end: pos.offset + name.length, line: pos.line, col: pos.col, ...extra };
    this.symbols.push(s);
    return s;
  }

  builtin(name) {
    let s = this.builtins.get(name);
    if (!s) {
      s = { id: -1 - this.builtins.size, name, kind: "builtin", start: -1, end: -1 };
      this.builtins.set(name, s);
    }
    return s;
  }

  /** Declare a name in `scope`; `visibleFrom` is the offset it can be used from
   *  (−∞ for a hoisted function, ∞ while a let's own value is being read). */
  declare(scope, name, kind, pos, extra = {}) {
    const s = this.sym(name, kind, pos, extra);
    s.visibleFrom = extra.visibleFrom ?? pos.offset;
    s.scope = scope;
    if (!scope.decls.has(name)) scope.decls.set(name, s);
    else this.dups.push(s); // "already defined here" when it runs
    this.occ.push({ start: s.start, end: s.end, sym: s, write: true, decl: true });
    return s;
  }

  resolve(scope, name, offset) {
    let closure = false;
    for (let s = scope; s; s = s.parent) {
      const d = s.decls.get(name);
      if (d && (closure || offset >= d.visibleFrom)) return d;
      if (s.fn) closure = true; // anything outside a function is seen when it runs, later
    }
    return BUILTIN_NAMES.has(name) ? this.builtin(name) : null;
  }

  ref(scope, node, write = false) {
    const sym = this.resolve(scope, node.name, node.pos.offset);
    if (!sym) return null;
    this.occ.push({
      start: node.pos.offset, end: node.pos.offset + node.name.length, sym, write,
      shorthand: node.shorthand === true,
    });
    return sym;
  }

  // ── statements ──

  program(ast) {
    const top = new AScope(null);
    this.block(ast.body, top);
    this.outline(ast.body);
  }

  /** Declare what a block declares up front (the hoisted functions, and the
   *  lets, lanes and instruments, not yet visible), then walk it. */
  block(body, scope) {
    for (const st of body) {
      if (st.k === "fn") {
        st.sym = this.declare(scope, st.name, "function", st.namePos, { visibleFrom: -Infinity, node: st, params: [] });
      } else if (st.k === "let") {
        st.syms = [];
        this.pattern(st.target, scope, "variable", st.syms, Infinity);
      } else if (st.k === "decl" && (st.kind === "instrument" || st.kind === "lane")) {
        st.sym = this.declare(scope, st.name, st.kind, st.namePos, { visibleFrom: Infinity });
      }
    }
    for (const st of body) this.stmt(st, scope);
  }

  stmt(st, scope) {
    switch (st.k) {
      case "expr": this.expr(st.expr, scope); return;
      case "let": {
        // the value is read before the name exists (`let x = x + 1` reads an outer x)
        const syms = st.syms;
        if (st.value.k === "fnlit" && syms.length === 1) syms[0].fnNode = st.value;
        this.expr(st.value, scope, syms.length === 1 ? syms[0] : null);
        for (const s of syms) s.visibleFrom = s.start;
        return;
      }
      case "assign": {
        if (st.target.k === "ident") {
          if (st.op !== "=") this.ref(scope, st.target);
          this.ref(scope, st.target, true);
        } else this.expr(st.target, scope);
        this.expr(st.value, scope);
        return;
      }
      case "fn": this.fnBody(st, st.sym, scope); return;
      case "block": this.block(st.body, new AScope(scope)); return;
      case "if":
        this.expr(st.cond, scope);
        this.block(st.then.body, new AScope(scope));
        if (st.else) this.block(st.else.body, new AScope(scope));
        return;
      case "while":
        this.expr(st.cond, scope);
        this.block(st.body.body, new AScope(scope));
        return;
      case "for": {
        this.expr(st.iter, scope);
        const inner = new AScope(scope);
        if (st.key) this.pattern(st.key, inner, "loop");
        this.pattern(st.item, inner, "loop");
        this.block(st.body.body, inner);
        return;
      }
      case "return": if (st.value) this.expr(st.value, scope); return;
      case "decl": {
        this.expr(st.value, scope);
        if (st.sym) st.sym.visibleFrom = st.sym.start;
        return;
      }
      case "section":
        this.expr(st.name, scope);
        this.expr(st.range, scope);
        return;
      default: return;
    }
  }

  pattern(p, scope, kind, out = null, visibleFrom = undefined) {
    if (p.k === "ident") {
      const s = this.declare(scope, p.name, kind, p.pos, visibleFrom === undefined ? {} : { visibleFrom });
      out?.push(s);
      return;
    }
    for (const q of p.items) this.pattern(q, scope, kind, out, visibleFrom);
  }

  /** A function's parameters and body, in a scope of their own. */
  fnBody(node, sym, scope) {
    const inner = new AScope(scope, true, node.pos.offset, node.end ?? Infinity);
    if (sym) this.encl.push(sym);
    const params = [];
    for (const p of node.params) {
      if (p.def) this.expr(p.def, inner);
      params.push(this.declare(inner, p.name, "parameter", p.pos, { owner: sym }));
    }
    if (sym) sym.params = params;
    if (node.k === "fnlit" && node.expr) this.expr(node.body, inner);
    else this.block(node.body.body, inner);
    if (sym) this.encl.pop();
    return params;
  }

  // ── expressions ──

  expr(e, scope, named = null) {
    if (!e) return;
    switch (e.k) {
      case "ident": this.ref(scope, e); return;
      case "interp": for (const p of e.parts) if (typeof p !== "string") this.expr(p, scope); return;
      case "list": for (const x of e.items) this.expr(x, scope); return;
      case "rec": for (const en of e.entries) this.expr(en.value, scope); return;
      case "fnlit": {
        // a lambda bound by `let f = fn(…)` is that name's function; any other
        // is part of whatever function holds it
        const params = this.fnBody(e, named, scope);
        if (named) named.params = params;
        return;
      }
      case "cond": this.expr(e.c, scope); this.expr(e.a, scope); this.expr(e.b, scope); return;
      case "and": case "or": case "bin": this.expr(e.a, scope); this.expr(e.b, scope); return;
      case "not": case "unary": this.expr(e.x, scope); return;
      case "range": this.expr(e.from, scope); this.expr(e.to, scope); this.expr(e.by, scope); return;
      case "index": this.expr(e.x, scope); this.expr(e.i, scope); return;
      case "field": this.expr(e.x, scope); return;
      case "call": {
        let callee = null;
        if (e.f.k === "ident") callee = this.ref(scope, e.f);
        else this.expr(e.f, scope);
        const call = {
          start: e.pos.offset, end: e.end ?? e.pos.offset, callee,
          name: e.f.k === "ident" ? e.f.name : null,
          encl: this.encl.length ? this.encl[this.encl.length - 1] : null,
          line: e.pos.line, col: e.pos.col,
        };
        this.calls.push(call);
        for (const a of e.args) this.expr(a, scope);
        for (const n of e.named) {
          this.expr(n.value, scope);
          if (callee) this.pendingNamed.push({ callee, name: n.name, pos: n.pos });
        }
        return;
      }
      default: return;
    }
  }

  // ── the outline ──

  outline(body) {
    const src = this.source;
    const str = (e) => (e?.k === "str" ? e.v : null);
    const text = (e) => (e && e.end !== undefined ? src.slice(e.pos.offset, e.end) : null);
    const field = (rec, key) => rec?.k === "rec" ? rec.entries.find((en) => en.key === key)?.value : undefined;
    const item = (kind, name, detail, start, children = null) => ({ kind, name, detail, start, children });
    const fnItem = (st) => {
      const kids = [];
      const walk = (stmts) => {
        for (const s of stmts) {
          if (s.k === "fn") kids.push(fnItem(s));
          else if (s.k === "block") walk(s.body);
        }
      };
      walk(st.body.body);
      return item("function", st.name, `(${st.params.map((p) => p.name).join(", ")})`, st.namePos.offset, kids.length ? kids : null);
    };
    const out = this.structure;
    for (const st of body) {
      if (st.k === "decl" && st.kind === "song") {
        out.push(item("song", str(field(st.value, "title")) ?? "song", str(field(st.value, "tuning")) ?? "", st.pos.offset));
      } else if (st.k === "decl" && st.kind === "master") {
        out.push(item("master", "master", "", st.pos.offset));
      } else if (st.k === "decl" && st.kind === "instrument") {
        const v = st.value;
        const src2 = field(v, "bank") !== undefined ? "soundfont" : field(v, "pack") !== undefined ? "pack"
          : field(v, "wave") !== undefined ? "wave" : field(v, "layers") !== undefined ? "layers"
          : field(v, "fm") !== undefined ? "fm" : "";
        out.push(item("instrument", st.name, src2, st.namePos.offset));
      } else if (st.k === "decl" && st.kind === "lane") {
        const inst = field(st.value, "inst");
        out.push(item("lane", st.name, inst?.k === "ident" ? inst.name : "", st.namePos.offset));
      } else if (st.k === "section") {
        // the bars as written, after the name (a section is one line)
        const nl = src.indexOf("\n", st.pos.offset);
        const line = src.slice(st.pos.offset, nl < 0 ? src.length : nl).replace(/\/\/.*$|\/\*.*?\*\//g, "");
        const bars = /^section\s*"(?:[^"\\]|\\.)*"(.*)$/.exec(line)?.[1].trim() ?? "";
        out.push(item("section", str(st.name) ?? "section", bars, st.pos.offset));
      } else if (st.k === "fn") {
        out.push(fnItem(st));
      } else if (st.k === "let") {
        const names = [];
        const collect = (p) => { if (p.k === "ident") names.push(p); else p.items.forEach(collect); };
        collect(st.target);
        for (const p of names) out.push(item("variable", p.name, "", p.pos.offset));
      }
    }
  }

  result() {
    // named arguments name the callee's parameters
    for (const n of this.pendingNamed) {
      const p = n.callee.params?.find((q) => q.name === n.name);
      if (p) this.occ.push({ start: n.pos.offset, end: n.pos.offset + n.name.length, sym: p, write: false, named: true });
    }
    this.occ.sort((a, b) => a.start - b.start);
    return new Analysis(this);
  }
}

export class Analysis {
  constructor(a) {
    this.ok = true;
    this.source = a.source;
    this.symbols = a.symbols;
    this.occ = a.occ;
    this.calls = a.calls;
    this.structure = a.structure;
    this.dups = a.dups;
  }

  /** The occurrence of a name at (or just after) `offset`, or null. */
  occAt(offset) {
    let lo = 0, hi = this.occ.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const o = this.occ[mid];
      if (offset < o.start) hi = mid - 1;
      else if (offset > o.end) lo = mid + 1;
      else return o;
    }
    return null;
  }

  /** Every place a symbol is named, in order — once each: `x += 1` reads and
   *  writes x at one place, and comes back as one write. */
  occurrencesOf(sym) {
    const out = [];
    for (const o of this.occ) {
      if (o.sym !== sym) continue;
      const last = out[out.length - 1];
      if (last && last.start === o.start) { if (o.write && !last.write) out[out.length - 1] = o; }
      else out.push(o);
    }
    return out;
  }

  /** The innermost call whose text holds `offset`, or null. */
  callAt(offset) {
    let best = null;
    for (const c of this.calls) {
      if (offset >= c.start && offset <= c.end && (!best || c.end - c.start < best.end - best.start)) best = c;
    }
    return best;
  }

  /** Who calls `sym`: [{fn (the calling function, or null for the top level), sites}]. */
  callers(sym) {
    const groups = new Map();
    for (const c of this.calls) {
      if (c.callee !== sym) continue;
      const k = c.encl ?? null;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    return [...groups].map(([fn, sites]) => ({ fn, sites })).sort((p, q) => p.sites[0].start - q.sites[0].start);
  }

  /** What `sym` calls: [{fn (the called function), sites}]. */
  callees(sym) {
    const groups = new Map();
    for (const c of this.calls) {
      if (c.encl !== sym || !c.callee) continue;
      if (!groups.has(c.callee)) groups.set(c.callee, []);
      groups.get(c.callee).push(c);
    }
    return [...groups].map(([fn, sites]) => ({ fn, sites })).sort((p, q) => p.sites[0].start - q.sites[0].start);
  }
}

// ── rename ──

/**
 * Rename the symbol named at `offset` to `newName`. Returns {source, count}
 * or {error}. Every place the program names it changes — its declaration,
 * its uses, the named arguments that name a parameter, and `{ name }`
 * shorthands, which keep their field (`{ name: renamed }`) — and nothing else.
 * Refused when the result would make any name in the program mean something
 * it did not mean before (a capture, a clash, a builtin hidden): the program
 * is analysed again and compared, use by use.
 */
export function planRename(source, offset, newName) {
  const a = analyze(source);
  if (!a.ok) return { error: "parse", detail: a.error };
  const o = a.occAt(offset);
  if (!o) return { error: "notName" };
  const sym = o.sym;
  if (sym.kind === "builtin") return { error: "builtin", name: sym.name };
  if (!isIdentifier(newName)) return { error: "badName", name: newName };
  if (newName === sym.name) return { source, count: 0 };
  const occs = a.occurrencesOf(sym);
  const edits = occs.map((x) => ({
    start: x.start, end: x.end,
    text: x.shorthand ? `${sym.name}: ${newName}` : newName,
    // where the name itself lands inside the replacement
    at: x.shorthand ? sym.name.length + 2 : 0,
  }));
  let out = source;
  for (const e of [...edits].sort((p, q) => q.start - p.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // an offset of the old text → the new text
  const shift = (pos) => {
    let d = 0;
    for (const e of edits) if (e.end <= pos) d += e.text.length - (e.end - e.start);
    return pos + d;
  };
  const b = analyze(out);
  if (!b.ok) return { error: "breaks", line: b.error?.pos?.line ?? 0 };
  // a name declared twice in one scope is an error when the program runs
  const dup = b.dups.find((d) => d.name === newName);
  if (dup) return { error: "conflict", name: newName, line: dup.line };
  // where each old declaration is now
  const declAt = (s) => (s.kind === "builtin" ? `builtin:${s.name}` : `decl:${s === sym ? shift(s.start) + edits.find((e) => e.start === s.start).at : shift(s.start)}`);
  // position → what each name there must mean (`x += 1` names x twice there)
  const want = new Map();
  for (const x of a.occ) {
    const e = x.sym === sym ? edits.find((ed) => ed.start === x.start) : null;
    const at = e ? shift(x.start) + e.at : shift(x.start);
    if (!want.has(at)) want.set(at, []);
    want.get(at).push(declAt(x.sym));
  }
  const lineOf = (pos) => out.slice(0, pos).split("\n").length;
  for (const y of b.occ) {
    const key = y.sym.kind === "builtin" ? `builtin:${y.sym.name}` : `decl:${y.sym.start}`;
    const list = want.get(y.start);
    const k = list ? list.indexOf(key) : -1;
    if (k < 0) return { error: "conflict", name: newName, line: lineOf(y.start) };
    list.splice(k, 1);
  }
  for (const [at, list] of want) if (list.length) return { error: "conflict", name: newName, line: lineOf(at) };
  return { source: out, count: occs.length };
}
