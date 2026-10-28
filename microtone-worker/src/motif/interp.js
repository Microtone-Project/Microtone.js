// Taud Motif Language (TML) — the interpreter. Walks the syntax tree the
// parser builds, with nothing but the builtins it is handed: a TML program
// cannot reach the page, the network, the file system or the clock, and it
// runs on a budget of steps and a bounded call depth, so the worst a hostile
// file can do is fail to build. (The values it computes with are values.js.)
//
// A TML 1 program runs top to bottom, and its music builtins write into the
// song as it goes. A TML 2 program is read declaratively: every name a block
// defines (a let, a fn, a lane, an instrument) can be used anywhere in that
// block — a let is computed the first time it is needed — and the block's
// music is every phrase its statements make, put together (hooks.music()), so
// the order the statements are written in changes nothing.

import { MotifError } from "./lexer.js";
import {
  DEFAULT_STEPS, DEFAULT_DEPTH, Rec, Range, Closure, Builtin, Handle, Phrase, Thunk, typeName, truthy, equal, show,
  fail, asNumber, asInt, asString, asRecord, toList, checkSize, entriesOf,
} from "./values.js";

// ── scopes ──

export class Scope {
  constructor(parent = null, frozen = false) { this.vars = new Map(); this.parent = parent; this.frozen = frozen; }
  find(name) {
    for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s;
    return null;
  }
}

const BREAK = { sig: "break" };
const CONTINUE = { sig: "continue" };

const an = (word) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

// ── the interpreter ──

export class Interp {
  /**
   * @param builtins  Map name → value: everything a program can see besides
   *                  its own definitions
   * @param hooks     {declare(node, scope, interp, index)} for song / instrument
   *                  / lane / master / section declarations,
   *                  {pitch(text, pos)} for 'D5' literals, and (TML 2)
   *                  {music()} → an accumulator of phrases (phrase.js Music)
   */
  constructor({ builtins, hooks = {}, steps = DEFAULT_STEPS, depth = DEFAULT_DEPTH } = {}) {
    this.root = new Scope(null, true);
    for (const [k, v] of builtins) this.root.vars.set(k, v);
    this.global = new Scope(this.root);
    this.hooks = hooks;
    this.steps = steps;
    this.stepLimit = steps;
    this.maxDepth = depth;
    this.stack = []; // [{name, pos}] of the TML calls in progress
    this.v2 = false;
    /** TML 2: the offset of the call a preview captures, and how many
     *  evaluations of it are in progress. */
    this.captureAt = null;
    this.capturing = 0;
    /** TML 2: the music the program made (its song, before resolve()). */
    this.result = null;
  }

  tick(pos) {
    if (--this.steps < 0) {
      throw new MotifError(`the program ran for more than ${this.stepLimit.toLocaleString("en")} steps — an endless loop?`, pos);
    }
  }

  run(program) {
    this.v2 = program.version >= 2;
    try {
      if (this.v2) {
        const music = this.hooks.music();
        this.execBlock2(program.body, this.global, music, true);
        this.result = music.phrase();
      } else {
        this.execBody(program.body, this.global);
      }
    } catch (err) {
      throw this.wrap(err, program.pos);
    }
  }

  wrap(err, pos) {
    if (err instanceof MotifError) {
      if (!err.pos) err.pos = pos;
      return err;
    }
    if (err instanceof RangeError && /call stack/i.test(err.message)) {
      return new MotifError("the program nests too deeply (a recursion without an end?)", pos, this.trace());
    }
    const e = new MotifError(`internal error: ${err?.message ?? err}`, pos, this.trace());
    e.cause = err;
    return e;
  }

  trace() {
    return this.stack.slice().reverse().map((f) => ({ name: f.name, line: f.pos?.line, col: f.pos?.col }));
  }

  // ── statements ──

  execBody(body, scope) {
    // Named functions are visible from the top of their block, so a file can
    // read top-down and two functions can call each other.
    for (const st of body) {
      if (st.k === "fn") this.declare(scope, st.name, new Closure(st.name, st.params, st.body, st.expr === true, scope), st.pos);
    }
    for (const st of body) {
      const sig = this.exec(st, scope);
      if (sig) return sig;
    }
    return null;
  }

  // ── TML 2 ──

  /**
   * A TML 2 block: its definitions first (functions; lets as thunks; at the
   * top, the declarations — the song, then the master, the instruments, the
   * lanes and the sections, each kind in the order written), then every let
   * computed in the order written (each after whatever it needs), then its
   * statements, whose music goes into `music`. Returns a return signal or null.
   */
  execBlock2(body, scope, music, top = false) {
    const lets = [];
    for (const st of body) {
      if (st.k === "fn") this.declare(scope, st.name, new Closure(st.name, st.params, st.body, st.expr === true, scope), st.pos);
      else if (st.k === "let") lets.push(...this.defineLet(st, scope));
    }
    if (top) this.declareAll(body, scope);
    for (const t of lets) this.force(t, t.pos);
    for (const st of body) {
      const sig = this.exec2(st, scope, music);
      if (sig) return sig;
    }
    return null;
  }

  /** A let's names, bound to thunks; returns the thunks to compute. */
  defineLet(st, scope) {
    const whole = new Thunk(() => this.eval(st.value, scope));
    whole.pos = st.pos;
    if (st.target.k === "ident") {
      whole.name = st.target.name;
      this.declare(scope, st.target.name, whole, st.target.pos);
      return [whole];
    }
    const out = [whole];
    const bindPat = (pat, get) => {
      if (pat.k === "ident") {
        const t = new Thunk(get);
        t.name = pat.name;
        t.pos = pat.pos;
        this.declare(scope, pat.name, t, pat.pos);
        out.push(t);
        return;
      }
      pat.items.forEach((p, i) => bindPat(p, () => this.unpack(pat, get(), i)));
    };
    bindPat(st.target, () => this.force(whole, st.pos));
    return out;
  }

  unpack(pat, value, i) {
    const xs = value instanceof Range ? toList(value) : value;
    if (!Array.isArray(xs)) throw new MotifError(`cannot unpack ${typeName(value)} into [${pat.items.length} names]`, pat.pos);
    if (xs.length !== pat.items.length) {
      throw new MotifError(`cannot unpack a list of ${xs.length} into ${pat.items.length} names`, pat.pos);
    }
    return xs[i];
  }

  /** A thunk's value, computing it the first time. */
  force(t, pos) {
    if (t.state === 2) return t.value;
    if (t.state === 1) {
      throw new MotifError(`${t.name ? `"${t.name}"` : "this let"} is defined in terms of itself`, pos);
    }
    t.state = 1;
    try {
      t.value = t.compute();
    } catch (err) {
      t.state = 0;
      throw this.wrap(err, t.pos);
    }
    t.state = 2;
    t.compute = null;
    return t.value;
  }

  /** The top's declarations: lanes and instruments are numbered in the order
   *  written, whatever order their names are first needed in. (A chain is
   *  numbered by the instruments, so it needs no index of its own.) */
  declareAll(body, scope) {
    const rank = { song: 0, master: 1, chain: 2, instrument: 3, lane: 4 };
    const decls = [];
    let instruments = 0, lanes = 0;
    for (const st of body) {
      if (st.k === "section") { decls.push([st, null, 5]); continue; }
      if (st.k !== "decl") continue;
      let t = null;
      if (st.kind === "instrument" || st.kind === "lane" || st.kind === "chain") {
        const index = st.kind === "instrument" ? instruments++ : st.kind === "lane" ? lanes++ : 0;
        t = new Thunk(() => this.hooks.declare(st, scope, this, index));
        t.name = st.name;
        t.pos = st.pos;
        this.declare(scope, st.name, t, st.namePos);
      }
      decls.push([st, t, rank[st.kind]]);
    }
    decls.sort((a, b) => a[2] - b[2]); // stable: each kind stays in the order written
    for (const [st, t] of decls) {
      this.tick(st.pos);
      try {
        if (t) this.force(t, st.pos);
        else this.hooks.declare(st, scope, this);
      } catch (err) {
        throw this.wrap(err, st.pos);
      }
    }
  }

  exec2(st, scope, music) {
    switch (st.k) {
      case "fn": case "let": case "decl": case "section": return null;
      default: break;
    }
    this.tick(st.pos);
    try {
      switch (st.k) {
        case "expr": this.addMusic(music, this.eval(st.expr, scope)); return null;
        case "block": return this.execBlock2(st.body, new Scope(scope), music);
        case "if": {
          if (truthy(this.eval(st.cond, scope))) return this.execBlock2(st.then.body, new Scope(scope), music);
          if (st.else) return this.execBlock2(st.else.body, new Scope(scope), music);
          return null;
        }
        case "for": {
          const it = this.eval(st.iter, scope);
          for (const [k, v] of entriesOf(it)) {
            const inner = new Scope(scope);
            if (st.key) this.bind(st.key, k, inner, true);
            this.bind(st.item, v, inner, true);
            if (st.cond && !truthy(this.eval(st.cond, inner))) continue;
            const sig = this.execBlock2(st.body.body, inner, music);
            if (sig) return sig;
          }
          return null;
        }
        case "return":
          return { sig: "return", value: st.value ? this.eval(st.value, scope) : null };
        default: throw new MotifError(`internal error: statement ${st.k}`, st.pos);
      }
    } catch (err) {
      throw this.wrap(err, st.pos);
    }
  }

  /** A statement's value into its block's music: a phrase, none, or a list of them. */
  addMusic(music, v) {
    if (v === null || v === undefined) return;
    if (v instanceof Phrase) { music.add(v); return; }
    if (Array.isArray(v)) {
      const bad = v.find((x) => !(x === null || x instanceof Phrase || Array.isArray(x)));
      if (bad !== undefined) {
        throw fail(`this line makes a list with ${an(typeName(bad))} in it, and nothing uses it: in TML 2 a line on its own is music (phrases); name a value with let`);
      }
      for (const x of v) this.addMusic(music, x);
      return;
    }
    throw fail(`this line makes ${an(typeName(v))} and nothing uses it: in TML 2 a line on its own is music (a phrase); name a value with let`);
  }

  declare(scope, name, value, pos) {
    if (scope.vars.has(name)) throw new MotifError(`"${name}" is already defined here`, pos);
    scope.vars.set(name, value);
  }

  exec(st, scope) {
    this.tick(st.pos);
    try {
      switch (st.k) {
        case "expr": this.eval(st.expr, scope); return null;
        case "let": this.bind(st.target, this.eval(st.value, scope), scope, true); return null;
        case "assign": this.assign(st, scope); return null;
        case "fn": return null; // hoisted by execBody
        case "block": return this.execBody(st.body, new Scope(scope));
        case "if": {
          if (truthy(this.eval(st.cond, scope))) return this.execBody(st.then.body, new Scope(scope));
          if (st.else) return this.execBody(st.else.body, new Scope(scope));
          return null;
        }
        case "for": return this.execFor(st, scope);
        case "while": {
          while (truthy(this.eval(st.cond, scope))) {
            const sig = this.execBody(st.body.body, new Scope(scope));
            if (sig === BREAK) break;
            if (sig && sig !== CONTINUE) return sig;
          }
          return null;
        }
        case "return":
          return { sig: "return", value: st.value ? this.eval(st.value, scope) : null };
        case "break": return BREAK;
        case "continue": return CONTINUE;
        case "decl": case "section": {
          if (!this.hooks.declare) throw new MotifError(`${st.kind ?? "section"} declarations are not available here`, st.pos);
          this.hooks.declare(st, scope, this);
          return null;
        }
        default: throw new MotifError(`internal error: statement ${st.k}`, st.pos);
      }
    } catch (err) {
      throw this.wrap(err, st.pos);
    }
  }

  execFor(st, scope) {
    const it = this.eval(st.iter, scope);
    for (const [k, v] of entriesOf(it)) {
      const inner = new Scope(scope);
      if (st.key) this.bind(st.key, k, inner, true);
      this.bind(st.item, v, inner, true);
      const sig = this.execBody(st.body.body, inner);
      if (sig === BREAK) break;
      if (sig && sig !== CONTINUE) return sig;
    }
    return null;
  }

  /** `let` (fresh names in `scope`) or a pattern bound by a for-loop. */
  bind(pat, value, scope, fresh) {
    if (pat.k === "ident") {
      if (fresh) this.declare(scope, pat.name, value, pat.pos);
      return;
    }
    const xs = value instanceof Range ? toList(value) : value;
    if (!Array.isArray(xs)) throw new MotifError(`cannot unpack ${typeName(value)} into [${pat.items.length} names]`, pat.pos);
    if (xs.length !== pat.items.length) {
      throw new MotifError(`cannot unpack a list of ${xs.length} into ${pat.items.length} names`, pat.pos);
    }
    pat.items.forEach((p, i) => this.bind(p, xs[i], scope, fresh));
  }

  assign(st, scope) {
    const t = st.target;
    const combine = (old) => {
      const rhs = this.eval(st.value, scope);
      if (st.op === "=") return rhs;
      return this.binop(st.op[0], old, rhs, st.pos);
    };
    if (t.k === "ident") {
      const s = scope.find(t.name);
      if (!s) throw new MotifError(`"${t.name}" is not defined (declare it first with let)`, t.pos);
      if (s.frozen) throw new MotifError(`"${t.name}" is built in and cannot be changed (let a new name instead)`, t.pos);
      s.vars.set(t.name, combine(s.vars.get(t.name)));
      return;
    }
    const obj = this.eval(t.x, scope);
    if (t.k === "field") {
      const r = asRecord(obj, "the value before \".\"");
      r.m.set(t.name, combine(st.op === "=" ? null : this.getField(r, t.name, t.pos)));
      return;
    }
    const key = this.eval(t.i, scope);
    if (Array.isArray(obj)) {
      const i = this.listIndex(obj, key, t.pos);
      obj[i] = combine(obj[i]);
      return;
    }
    if (obj instanceof Rec) {
      const k = asString(key, "a record key");
      obj.m.set(k, combine(st.op === "=" ? null : this.getField(obj, k, t.pos)));
      return;
    }
    throw new MotifError(`cannot assign into ${typeName(obj)}`, t.pos);
  }

  listIndex(xs, key, pos) {
    asInt(key, "a list index");
    const i = key < 0 ? xs.length + key : key;
    if (i < 0 || i >= xs.length) throw new MotifError(`index ${key} is outside the list (it has ${xs.length} items)`, pos);
    return i;
  }

  getField(v, name, pos) {
    if (v instanceof Rec) {
      if (!v.m.has(name)) throw new MotifError(`the record has no field "${name}"`, pos);
      return v.m.get(name);
    }
    if (v instanceof Handle) {
      if (!(name in v.fields)) throw new MotifError(`a ${v.kind} has no field "${name}"`, pos);
      return v.fields[name];
    }
    if (v instanceof Range) {
      if (name === "from") return v.from;
      if (name === "to") return v.to;
      if (name === "step") return v.step;
    }
    if (v instanceof Phrase) {
      if (name === "from") return v.from;
      if (name === "to") return v.to;
      if (name === "rows") return v.to - v.from;
      if (name === "lanes") {
        const lanes = new Set();
        for (const [l, rows] of v.cells) if (rows.size) lanes.add(l);
        for (const part of v.soft) if (part.self) lanes.add(part.lane);
        return [...lanes].sort((a, b) => a.index - b.index).map((l) => l.handle);
      }
      throw new MotifError(`a phrase has no field "${name}" (it has from, to, rows and lanes)`, pos);
    }
    throw new MotifError(`${typeName(v)} has no field "${name}"`, pos);
  }

  // ── expressions ──

  eval(e, scope) {
    this.tick(e.pos);
    switch (e.k) {
      case "num": return e.v;
      case "str": return e.v;
      case "bool": return e.v;
      case "none": return null;
      case "ident": {
        const s = scope.find(e.name);
        if (!s) throw new MotifError(`"${e.name}" is not defined`, e.pos);
        const v = s.vars.get(e.name);
        return v instanceof Thunk ? this.force(v, e.pos) : v;
      }
      case "pitch":
        if (!this.hooks.pitch) throw new MotifError("pitches are not available here", e.pos);
        try { return this.hooks.pitch(e.v); } catch (err) { throw this.wrap(err, e.pos); }
      case "interp": {
        let out = "";
        for (const p of e.parts) out += typeof p === "string" ? p : show(this.eval(p, scope));
        checkSize(out.length);
        return out;
      }
      case "list": return e.items.map((x) => this.eval(x, scope));
      case "comp": {
        const out = [];
        const walk = (i, sc) => {
          if (i === e.clauses.length) {
            out.push(this.eval(e.expr, sc));
            checkSize(out.length);
            return;
          }
          const c = e.clauses[i];
          if (c.k === "if") {
            if (truthy(this.eval(c.cond, sc))) walk(i + 1, sc);
            return;
          }
          for (const [k, v] of entriesOf(this.eval(c.iter, sc))) {
            this.tick(c.pos);
            const inner = new Scope(sc);
            if (c.key) this.bind(c.key, k, inner, true);
            this.bind(c.item, v, inner, true);
            walk(i + 1, inner);
          }
        };
        walk(0, scope);
        return out;
      }
      case "rec": {
        const r = new Rec();
        for (const en of e.entries) r.m.set(en.key, this.eval(en.value, scope));
        return r;
      }
      case "fnlit": return new Closure(null, e.params, e.body, e.expr, scope);
      case "cond": return truthy(this.eval(e.c, scope)) ? this.eval(e.a, scope) : this.eval(e.b, scope);
      case "and": { const a = this.eval(e.a, scope); return truthy(a) ? this.eval(e.b, scope) : a; }
      case "or": { const a = this.eval(e.a, scope); return truthy(a) ? a : this.eval(e.b, scope); }
      case "not": return !truthy(this.eval(e.x, scope));
      case "unary": {
        const x = this.eval(e.x, scope);
        try {
          if (e.op === "~") return ~asInt(x, "the operand of ~");
          const n = asNumber(x, `the operand of ${e.op}`);
          return e.op === "-" ? -n : n;
        } catch (err) { throw this.wrap(err, e.pos); }
      }
      case "bin": return this.binop(e.op, this.eval(e.a, scope), this.eval(e.b, scope), e.pos);
      case "range": {
        try {
          const from = asInt(this.eval(e.from, scope), "the start of a range");
          const to = asInt(this.eval(e.to, scope), "the end of a range");
          const step = e.by ? asInt(this.eval(e.by, scope), "a range's step") : 1;
          if (step === 0) throw fail("a range cannot step by 0");
          return new Range(from, to, step, e.inclusive);
        } catch (err) { throw this.wrap(err, e.pos); }
      }
      case "index": {
        const x = this.eval(e.x, scope);
        const k = this.eval(e.i, scope);
        try { return this.index(x, k, e.pos); } catch (err) { throw this.wrap(err, e.pos); }
      }
      case "field": return this.getField(this.eval(e.x, scope), e.name, e.pos);
      case "call": {
        // a preview (TML 2) captures everything this call makes, arguments and all
        const cap = this.captureAt !== null && e.pos.offset === this.captureAt;
        if (cap) this.capturing++;
        try {
          const f = this.eval(e.f, scope);
          const args = e.args.map((a) => this.eval(a, scope));
          const named = e.named.length ? e.named.map((n) => [n.name, this.eval(n.value, scope), n.pos]) : null;
          return this.call(f, args, named, e.pos, e.f.k === "ident" ? e.f.name : null);
        } finally {
          if (cap) this.capturing--;
        }
      }
      default: throw new MotifError(`internal error: expression ${e.k}`, e.pos);
    }
  }

  index(x, k, pos) {
    if (k instanceof Range) {
      if (!(Array.isArray(x) || typeof x === "string")) throw fail(`cannot slice ${typeName(x)}`);
      if (k.step !== 1) throw fail("a slice takes a range with step 1");
      const n = x.length;
      const a = Math.max(0, Math.min(n, k.from < 0 ? n + k.from : k.from));
      const endRaw = k.inclusive ? k.to + 1 : k.to;
      const b = Math.max(a, Math.min(n, k.to < 0 ? n + endRaw : endRaw));
      return x.slice(a, b);
    }
    if (Array.isArray(x)) return x[this.listIndex(x, k, pos)];
    if (typeof x === "string") {
      const cs = [...x];
      return cs[this.listIndex(cs, k, pos)];
    }
    if (x instanceof Rec) return this.getField(x, asString(k, "a record key"), pos);
    if (x instanceof Range) return x.at(this.listIndex({ length: x.length }, k, pos));
    throw fail(`cannot index ${typeName(x)}`);
  }

  binop(op, a, b, pos) {
    try {
      switch (op) {
        case "==": return equal(a, b);
        case "!=": return !equal(a, b);
        case "<": case "<=": case ">": case ">=": {
          if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) {
            throw fail(`cannot compare ${typeName(a)} with ${typeName(b)}`);
          }
          return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
        }
        case "+":
          if (typeof a === "number" && typeof b === "number") return a + b;
          if (typeof a === "string" && typeof b === "string") { checkSize(a.length + b.length); return a + b; }
          if (Array.isArray(a) && Array.isArray(b)) { checkSize(a.length + b.length); return a.concat(b); }
          throw fail(`cannot add ${typeName(a)} and ${typeName(b)}${typeof a === "string" || typeof b === "string" ? " (write \"…${x}…\" to put a value in a string)" : ""}`);
        case "*":
          if (typeof a === "number" && typeof b === "number") return a * b;
          if ((Array.isArray(a) || typeof a === "string") && typeof b === "number") return repeatSeq(a, b);
          if ((Array.isArray(b) || typeof b === "string") && typeof a === "number") return repeatSeq(b, a);
          throw fail(`cannot multiply ${typeName(a)} by ${typeName(b)}`);
        case "-": return asNumber(a, "the left of -") - asNumber(b, "the right of -");
        case "/": {
          const d = asNumber(b, "the divisor");
          if (d === 0) throw fail("division by zero");
          return asNumber(a, "the dividend") / d;
        }
        case "%": {
          const d = asNumber(b, "the divisor");
          if (d === 0) throw fail("modulo by zero");
          const n = asNumber(a, "the left of %");
          return n - d * Math.floor(n / d); // floored: the sign follows the divisor
        }
        case "**": return asNumber(a, "the base") ** asNumber(b, "the exponent");
        case "&": return asInt(a, "the left of &") & asInt(b, "the right of &");
        case "|": return asInt(a, "the left of |") | asInt(b, "the right of |");
        case "^": return asInt(a, "the left of ^") ^ asInt(b, "the right of ^");
        case "<<": return asInt(a, "the left of <<") << asInt(b, "the right of <<");
        case ">>": return asInt(a, "the left of >>") >> asInt(b, "the right of >>");
        default: throw fail(`internal error: operator ${op}`);
      }
    } catch (err) {
      throw this.wrap(err, pos);
    }
  }

  /** Call a TML value. `named` is [[name, value, pos]] or null. */
  call(f, args, named, pos, label = null) {
    if (!(f instanceof Closure || f instanceof Builtin)) {
      throw new MotifError(`${label ? `"${label}"` : "this"} is ${typeName(f)}, not a function`, pos);
    }
    if (this.stack.length >= this.maxDepth) {
      throw new MotifError(`calls nest more than ${this.maxDepth} deep (a recursion without an end?)`, pos, this.trace());
    }
    const name = f.name ?? label ?? "(anonymous)";
    this.stack.push({ name, pos });
    try {
      if (f instanceof Builtin) return this.callBuiltin(f, args, named, pos);
      return this.callClosure(f, args, named, pos, name);
    } catch (err) {
      const e = this.wrap(err, pos);
      if (!e.trace) e.trace = this.trace();
      throw e;
    } finally {
      this.stack.pop();
    }
  }

  callBuiltin(f, args, named, pos) {
    const n = f.params.length;
    if (args.length > n && !f.rest) throw new MotifError(`${f.name}() takes at most ${n} argument${n === 1 ? "" : "s"}, not ${args.length}`, pos);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = i < args.length ? args[i] : undefined;
    if (named) {
      for (const [k, v, p] of named) {
        const i = f.params.findIndex((q) => q.name === k);
        if (i < 0) throw new MotifError(`${f.name}() has no parameter "${k}"`, p);
        if (i < args.length) throw new MotifError(`${f.name}(): "${k}" is given twice`, p);
        out[i] = v;
      }
    }
    for (let i = 0; i < n; i++) {
      if (out[i] === undefined) {
        if (f.params[i].required) throw new MotifError(`${f.name}() needs its "${f.params[i].name}" argument`, pos);
        out[i] = f.params[i].def;
      }
    }
    if (f.rest) out.push(...args.slice(n));
    const r = f.fn.apply(null, [this, ...out]);
    return r === undefined ? null : r;
  }

  callClosure(f, args, named, pos, name) {
    const scope = new Scope(f.scope);
    const ps = f.params;
    if (args.length > ps.length) throw new MotifError(`${name}() takes at most ${ps.length} argument${ps.length === 1 ? "" : "s"}, not ${args.length}`, pos);
    const given = new Map();
    args.forEach((a, i) => given.set(ps[i].name, a));
    if (named) {
      for (const [k, v, p] of named) {
        if (!ps.some((q) => q.name === k)) throw new MotifError(`${name}() has no parameter "${k}"`, p);
        if (given.has(k)) throw new MotifError(`${name}(): "${k}" is given twice`, p);
        given.set(k, v);
      }
    }
    for (const p of ps) {
      if (given.has(p.name)) scope.vars.set(p.name, given.get(p.name));
      else if (p.def) scope.vars.set(p.name, this.eval(p.def, scope));
      else throw new MotifError(`${name}() needs its "${p.name}" argument`, pos);
    }
    if (f.expr) return this.eval(f.body, scope);
    if (this.v2) {
      // a function's value is the music its body makes, with any phrase it
      // returns; or what it returns, when it makes no music
      const music = this.hooks.music();
      const sig = this.execBlock2(f.body.body, scope, music);
      const ret = sig ? sig.value : null;
      const made = music.phrase();
      if (ret === null) return made;
      if (made === null) return ret;
      if (ret instanceof Phrase) { music.add(ret); return music.phrase(); }
      throw new MotifError(`${name}() makes music and also returns ${an(typeName(ret))}: a function gives back one or the other (or a list of both)`, pos);
    }
    const sig = this.execBody(f.body.body, scope);
    return sig ? sig.value : null;
  }
}

function repeatSeq(seq, n) {
  asInt(n, "the repeat count");
  if (n < 0) throw fail("cannot repeat a negative number of times");
  checkSize(seq.length * n);
  if (typeof seq === "string") return seq.repeat(n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(...seq);
  return out;
}
