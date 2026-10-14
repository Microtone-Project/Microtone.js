// Taud Motif Language (TML) — the parser. Tokens in, a syntax tree out.
//
// Line breaks end statements, except inside (), [] and record braces, and
// after an operator or a comma, so a long expression is broken after an
// operator or inside brackets. `;` also ends a statement. A block's `{` follows
// the condition of if/while and the iterable of for, so a record literal there
// needs parentheses (as in Rust and Go).
//
// TML 2 is declarative: the parser refuses what would change a value or run
// "until" (assignment, while, break, continue), keeps declarations at the top
// of the program, and adds comprehensions ([e for x in xs if c]), a filter on
// a for (for x in xs if c { … }) and expression functions (fn f(x) => e).

import { lex, MotifError, SourceMap } from "./lexer.js";

/** The language versions this parser reads. */
export const TML_VERSIONS = [1, 2];

const MAX_DEPTH = 200;

// precedence climbing for the binary operators between `not` and unary
const BINARY = [
  ["|"], ["^"], ["&"], ["<<", ">>"], ["+", "-"], ["*", "/", "%"],
];
const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);
const ASSIGN = new Set(["=", "+=", "-=", "*=", "/="]);

function describe(tok) {
  switch (tok.t) {
    case "eof": return "the end of the file";
    case "nl": return "the end of the line";
    case "num": return `the number ${tok.v}`;
    case "str": return "a string";
    case "pitch": return `the pitch '${tok.v}'`;
    case "ident": return `"${tok.v}"`;
    default: return `"${tok.v}"`;
  }
}

export class Parser {
  constructor(src, { map = null, tokens = null } = {}) {
    this.src = src;
    this.map = map ?? new SourceMap(src);
    this.toks = tokens ?? lex(src, this.map);
    this.i = 0;
    this.nl = [false]; // top: are line breaks ignored here?
    this.noRecord = false;
    this.depth = 0;
    this.loops = 0;     // loops around the statement being parsed (in this function)
    this.fns = 0;       // functions around it
    this.blocks = 0;    // blocks around it (0: the top of the program)
    this.version = 1;
  }

  // ── token stream ──
  peek(k = 0) {
    let j = this.i;
    const skip = this.nl[this.nl.length - 1];
    for (let n = 0; ; j++) {
      const t = this.toks[j];
      if (t.t === "nl" && skip) continue;
      if (n === k || t.t === "eof") return t;
      n++;
    }
  }
  next() {
    const skip = this.nl[this.nl.length - 1];
    while (skip && this.toks[this.i].t === "nl") this.i++;
    const t = this.toks[this.i];
    if (t.t !== "eof") this.i++;
    return t;
  }
  /** Skip line breaks regardless of context (after an operator, a comma…). */
  skipNl() { while (this.toks[this.i].t === "nl") this.i++; }
  isOp(v, k = 0) { const t = this.peek(k); return t.t === "op" && t.v === v; }
  isKw(v, k = 0) { const t = this.peek(k); return t.t === "kw" && t.v === v; }
  isIdent(v = null, k = 0) { const t = this.peek(k); return t.t === "ident" && (v === null || t.v === v); }
  eatOp(v) { if (this.isOp(v)) { this.next(); return true; } return false; }
  expectOp(v, what = null) {
    const t = this.peek();
    if (t.t === "op" && t.v === v) return this.next();
    throw new MotifError(`expected "${v}"${what ? ` ${what}` : ""}, found ${describe(t)}`, t.pos);
  }
  expectKw(v) {
    const t = this.peek();
    if (t.t === "kw" && t.v === v) return this.next();
    throw new MotifError(`expected "${v}", found ${describe(t)}`, t.pos);
  }
  expectIdent(what) {
    const t = this.peek();
    if (t.t === "ident") return this.next();
    if (t.t === "kw") throw new MotifError(`"${t.v}" is a reserved word and cannot be used as ${what}`, t.pos);
    throw new MotifError(`expected ${what}, found ${describe(t)}`, t.pos);
  }
  enter(ignoreNl) { this.nl.push(ignoreNl); }
  leave() { this.nl.pop(); }
  deeper(pos) {
    if (++this.depth > MAX_DEPTH) throw new MotifError(`nested more than ${MAX_DEPTH} deep`, pos);
  }

  // ── program ──
  program() {
    this.skipNl();
    const head = this.peek();
    if (!(head.t === "kw" && head.v === "tml")) {
      throw new MotifError("a TML file starts with the language version: tml 1", head.pos);
    }
    this.next();
    const v = this.peek();
    if (v.t !== "num") throw new MotifError("expected the language version after tml, e.g. tml 1", v.pos);
    this.next();
    if (!TML_VERSIONS.includes(v.v)) {
      throw new MotifError(`this file is written in TML ${v.v}; this version of Microtone reads TML ${TML_VERSIONS.join(" and ")}`, v.pos);
    }
    this.version = v.v;
    this.endStatement();
    const body = [];
    for (;;) {
      this.skipSeparators();
      if (this.peek().t === "eof") break;
      body.push(this.statement());
      this.endStatement();
    }
    return { k: "program", version: v.v, body, pos: head.pos };
  }

  skipSeparators() {
    for (;;) {
      const t = this.toks[this.i];
      if (t.t === "nl" || (t.t === "op" && t.v === ";")) this.i++;
      else return;
    }
  }
  endStatement() {
    const t = this.toks[this.i];
    if (t.t === "nl" || t.t === "eof" || (t.t === "op" && (t.v === ";" || t.v === "}"))) return;
    throw new MotifError(`expected the end of the statement, found ${describe(t)}`, t.pos);
  }

  block() {
    const open = this.expectOp("{", "to open a block");
    this.enter(false);
    this.blocks++;
    const body = [];
    for (;;) {
      this.skipSeparators();
      const t = this.toks[this.i];
      if (t.t === "op" && t.v === "}") break;
      if (t.t === "eof") throw new MotifError("this block is never closed (} missing)", open.pos);
      body.push(this.statement());
      this.endStatement();
    }
    this.blocks--;
    this.leave();
    this.next(); // }
    return { k: "block", body, pos: open.pos };
  }

  /** The words TML 2 has no use for, and what to write instead. */
  notInV2(what, pos) {
    const why = {
      assign: "TML 2 never changes a name once it is defined: let a new name (a block's names can be used anywhere in it), or build the value in one go — a comprehension [… for x in xs], map() or scan()",
      while: "TML 2 has no while: loop over a range (for i in 0..<n), or let a function call itself",
      break: "TML 2 has no break or continue: put the condition on the loop (for x in xs if …) or in an if",
    }[what];
    return new MotifError(why, pos);
  }

  statement() {
    const t = this.peek();
    this.deeper(t.pos);
    try {
      if (t.t === "kw") {
        switch (t.v) {
          case "let": return this.letStatement();
          case "fn":
            if (this.peek(1).t === "ident") return this.fnDeclaration();
            break;
          case "for": return this.forStatement();
          case "while":
            if (this.version >= 2) throw this.notInV2("while", t.pos);
            return this.whileStatement();
          case "if":
            return this.ifStatement();
          case "return": {
            if (!this.fns) throw new MotifError("return outside a function", t.pos);
            this.next();
            const n = this.toks[this.i];
            const ends = n.t === "nl" || n.t === "eof" || (n.t === "op" && (n.v === ";" || n.v === "}"));
            return { k: "return", value: ends ? null : this.expression(), pos: t.pos };
          }
          case "break": case "continue":
            if (this.version >= 2) throw this.notInV2("break", t.pos);
            if (!this.loops) throw new MotifError(`${t.v} outside a loop`, t.pos);
            this.next();
            return { k: t.v, pos: t.pos };
          case "tml": throw new MotifError("the language version (tml 1) is written once, at the top of the file", t.pos);
          default: break;
        }
      }
      if (t.t === "ident") {
        const d = this.declaration(t);
        if (d) {
          if (this.version >= 2 && this.blocks) {
            throw new MotifError(`a ${d.kind ?? "section"} is declared at the top of the program, not inside a block or a function: a declaration says what the song is`, d.pos);
          }
          return d;
        }
      }
      // A "{" that starts a statement opens a block: a scope for its own lets.
      // (A record on its own as a statement would do nothing.)
      if (t.t === "op" && t.v === "{") return this.block();
      const e = this.expression();
      const a = this.peek();
      if (a.t === "op" && ASSIGN.has(a.v)) {
        if (this.version >= 2) throw this.notInV2("assign", a.pos);
        if (!(e.k === "ident" || e.k === "index" || e.k === "field")) {
          throw new MotifError("only a name, an element (xs[i]) or a field (r.x) can be assigned to", e.pos);
        }
        this.next();
        this.skipNl();
        return { k: "assign", target: e, op: a.v, value: this.expression(), pos: a.pos };
      }
      return { k: "expr", expr: e, pos: e.pos };
    } finally {
      this.depth--;
    }
  }

  /** song {…} · master {…} · instrument NAME {…} · lane NAME {…} · section "name" bars */
  declaration(t) {
    const name = t.v;
    if ((name === "song" || name === "master") && this.isOp("{", 1)) {
      this.next();
      return { k: "decl", kind: name, name: null, value: this.expression(), pos: t.pos };
    }
    if ((name === "instrument" || name === "lane") && this.peek(1).t === "ident" && this.isOp("{", 2)) {
      this.next();
      const id = this.next();
      return { k: "decl", kind: name, name: id.v, namePos: id.pos, value: this.expression(), pos: t.pos };
    }
    if (name === "section" && this.peek(1).t === "str") {
      this.next();
      const label = this.primary();
      return { k: "section", name: label, range: this.expression(), pos: t.pos };
    }
    return null;
  }

  pattern() {
    const t = this.peek();
    if (t.t === "op" && t.v === "[") {
      this.next();
      this.enter(true);
      const items = [];
      while (!this.isOp("]")) {
        items.push(this.pattern());
        if (!this.eatOp(",")) break;
      }
      this.expectOp("]", "to close the list pattern");
      this.leave();
      return { k: "listpat", items, pos: t.pos };
    }
    const id = this.expectIdent("a name");
    return { k: "ident", name: id.v, pos: id.pos };
  }

  letStatement() {
    const t = this.next();
    const target = this.pattern();
    this.expectOp("=", "after the name in let");
    this.skipNl();
    return { k: "let", target, value: this.expression(), pos: t.pos };
  }

  params() {
    this.expectOp("(", "to open the parameter list");
    this.enter(true);
    const params = [];
    const seen = new Set();
    while (!this.isOp(")")) {
      const id = this.expectIdent("a parameter name");
      if (seen.has(id.v)) throw new MotifError(`parameter "${id.v}" is listed twice`, id.pos);
      seen.add(id.v);
      let def = null;
      if (this.eatOp("=")) def = this.expression();
      else if (params.some((p) => p.def)) throw new MotifError(`parameter "${id.v}" needs a default: it follows one that has one`, id.pos);
      params.push({ name: id.v, def, pos: id.pos });
      if (!this.eatOp(",")) break;
    }
    this.expectOp(")", "to close the parameter list");
    this.leave();
    return params;
  }

  fnDeclaration() {
    const t = this.next();
    const id = this.expectIdent("the function's name");
    const params = this.params();
    if (this.version >= 2 && this.isOp("=>")) {
      // fn name(a, b) => expression
      this.next();
      this.skipNl();
      const saved = this.noRecord;
      this.noRecord = false;
      const body = this.fnBody(() => this.expression());
      this.noRecord = saved;
      return { k: "fn", name: id.v, namePos: id.pos, params, body, expr: true, pos: t.pos, end: this.toks[this.i - 1].end };
    }
    const saved = this.noRecord;
    this.noRecord = false;
    const body = this.fnBody(() => this.block());
    this.noRecord = saved;
    return { k: "fn", name: id.v, namePos: id.pos, params, body, pos: t.pos, end: this.toks[this.i - 1].end };
  }

  /** An expression whose end is a block's "{": no bare record literal. */
  head() {
    const saved = this.noRecord;
    this.noRecord = true;
    const e = this.expression();
    this.noRecord = saved;
    return e;
  }

  forStatement() {
    const t = this.next();
    let a = this.pattern();
    let b = null;
    if (this.eatOp(",")) b = this.pattern();
    this.expectKw("in");
    const iter = this.head();
    let cond = null;
    if (this.version >= 2 && this.isKw("if")) { this.next(); cond = this.head(); } // for x in xs if c { … }
    const body = this.loopBody();
    // `for x in` binds the item; `for i, x in` binds the index (or key) and the item
    return { k: "for", key: b ? a : null, item: b ?? a, iter, cond, body, pos: t.pos };
  }

  loopBody() {
    this.loops++;
    try { return this.block(); } finally { this.loops--; }
  }

  /** A function body: loops outside it do not reach in. */
  fnBody(parse) {
    const loops = this.loops;
    this.loops = 0;
    this.fns++;
    try { return parse(); } finally { this.loops = loops; this.fns--; }
  }

  whileStatement() {
    const t = this.next();
    const cond = this.head();
    return { k: "while", cond, body: this.loopBody(), pos: t.pos };
  }

  ifStatement() {
    const t = this.next();
    const cond = this.head();
    if (this.isKw("then")) {
      // `if c then a else b` used as a statement — an expression after all
      this.next();
      this.skipNl();
      const a = this.expression();
      this.skipNl();
      this.expectKw("else");
      this.skipNl();
      const b = this.expression();
      return { k: "expr", expr: { k: "cond", c: cond, a, b, pos: t.pos }, pos: t.pos };
    }
    const then = this.block();
    let otherwise = null;
    // `else` may start the next line after the closing brace
    let j = this.i;
    while (this.toks[j].t === "nl") j++;
    if (this.toks[j].t === "kw" && this.toks[j].v === "else") {
      this.i = j + 1;
      if (this.isKw("if")) {
        const inner = this.ifStatement();
        otherwise = { k: "block", body: [inner], pos: inner.pos };
      } else {
        otherwise = this.block();
      }
    }
    return { k: "if", cond, then, else: otherwise, pos: t.pos };
  }

  // ── expressions ──
  expression() {
    const t = this.peek();
    this.deeper(t.pos);
    try {
      if (t.t === "kw" && t.v === "if") {
        this.next();
        const c = this.expression();
        this.skipNl();
        this.expectKw("then");
        this.skipNl();
        const a = this.expression();
        this.skipNl();
        this.expectKw("else");
        this.skipNl();
        const b = this.expression();
        return { k: "cond", c, a, b, pos: t.pos };
      }
      return this.orExpr();
    } finally {
      this.depth--;
    }
  }

  orExpr() {
    let a = this.andExpr();
    while (this.isKw("or")) {
      const t = this.next();
      this.skipNl();
      a = { k: "or", a, b: this.andExpr(), pos: t.pos };
    }
    return a;
  }
  andExpr() {
    let a = this.notExpr();
    while (this.isKw("and")) {
      const t = this.next();
      this.skipNl();
      a = { k: "and", a, b: this.notExpr(), pos: t.pos };
    }
    return a;
  }
  notExpr() {
    if (this.isKw("not")) {
      const t = this.next();
      return { k: "not", x: this.notExpr(), pos: t.pos };
    }
    return this.compare();
  }
  compare() {
    const a = this.range();
    const t = this.peek();
    if (t.t === "op" && COMPARE.has(t.v)) {
      this.next();
      this.skipNl();
      const b = this.range();
      const n = this.peek();
      if (n.t === "op" && COMPARE.has(n.v)) {
        throw new MotifError("comparisons do not chain: write a < b and b < c", n.pos);
      }
      return { k: "bin", op: t.v, a, b, pos: t.pos };
    }
    return a;
  }
  range() {
    const a = this.binary(0);
    const t = this.peek();
    if (t.t === "op" && (t.v === ".." || t.v === "..<")) {
      this.next();
      this.skipNl();
      const b = this.binary(0);
      let by = null;
      if (this.isIdent("by")) { this.next(); this.skipNl(); by = this.binary(0); }
      return { k: "range", from: a, to: b, inclusive: t.v === "..", by, pos: t.pos };
    }
    return a;
  }
  binary(level) {
    if (level === BINARY.length) return this.unary();
    let a = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (!(t.t === "op" && BINARY[level].includes(t.v))) return a;
      this.next();
      this.skipNl();
      a = { k: "bin", op: t.v, a, b: this.binary(level + 1), pos: t.pos };
    }
  }
  unary() {
    const t = this.peek();
    if (t.t === "op" && (t.v === "-" || t.v === "+" || t.v === "~")) {
      this.next();
      this.deeper(t.pos);
      try {
        return { k: "unary", op: t.v, x: this.unary(), pos: t.pos };
      } finally { this.depth--; }
    }
    return this.power();
  }
  power() {
    const a = this.postfix();
    if (this.isOp("**")) {
      const t = this.next();
      this.skipNl();
      return { k: "bin", op: "**", a, b: this.unary(), pos: t.pos };
    }
    return a;
  }
  postfix() {
    let e = this.primary();
    for (;;) {
      const t = this.toks[this.i]; // a line break ends the chain (outside brackets)
      const u = this.peek();
      if (t.t === "nl" && !this.nl[this.nl.length - 1]) return e;
      if (u.t !== "op") return e;
      if (u.v === "(") e = this.call(e);
      else if (u.v === "[") {
        this.next();
        this.enter(true);
        const saved = this.noRecord;
        this.noRecord = false;
        const i = this.expression();
        this.noRecord = saved;
        this.expectOp("]", "to close the index");
        this.leave();
        e = { k: "index", x: e, i, pos: u.pos };
      } else if (u.v === ".") {
        this.next();
        const id = this.expectIdent("a field name after \".\"");
        e = { k: "field", x: e, name: id.v, pos: id.pos };
      } else return e;
    }
  }
  call(f) {
    const open = this.next();
    this.enter(true);
    const saved = this.noRecord;
    this.noRecord = false;
    const args = [];
    const named = [];
    while (!this.isOp(")")) {
      if (this.peek().t === "ident" && this.isOp(":", 1)) {
        const id = this.next();
        this.next();
        if (named.some((n) => n.name === id.v)) throw new MotifError(`"${id.v}" is given twice`, id.pos);
        named.push({ name: id.v, value: this.expression(), pos: id.pos });
      } else {
        if (named.length) throw new MotifError("a positional argument cannot follow a named one", this.peek().pos);
        args.push(this.expression());
      }
      if (!this.eatOp(",")) break;
    }
    const close = this.expectOp(")", "to close the call");
    this.noRecord = saved;
    this.leave();
    // an error in the call is reported where the call starts, at its name
    return { k: "call", f, args, named, pos: f.pos ?? open.pos, end: close.end };
  }

  primary() {
    const t = this.peek();
    switch (t.t) {
      case "num": this.next(); return { k: "num", v: t.v, pos: t.pos };
      case "pitch": this.next(); return { k: "pitch", v: t.v, pos: t.pos };
      case "str": this.next(); return this.stringNode(t);
      case "ident": this.next(); return { k: "ident", name: t.v, pos: t.pos };
      case "kw":
        if (t.v === "true" || t.v === "false") { this.next(); return { k: "bool", v: t.v === "true", pos: t.pos }; }
        if (t.v === "none") { this.next(); return { k: "none", pos: t.pos }; }
        if (t.v === "fn") return this.fnLiteral();
        if (t.v === "if") return this.expression();
        throw new MotifError(`"${t.v}" cannot start an expression`, t.pos);
      case "op":
        if (t.v === "(") {
          this.next();
          this.enter(true);
          const saved = this.noRecord;
          this.noRecord = false;
          const e = this.expression();
          this.noRecord = saved;
          this.expectOp(")", "to close the parenthesis");
          this.leave();
          return e;
        }
        if (t.v === "[") return this.listLiteral();
        if (t.v === "{") {
          if (this.noRecord) throw new MotifError("a record here needs parentheses: ({ … })", t.pos);
          return this.recordLiteral();
        }
        break;
      default: break;
    }
    throw new MotifError(`expected a value, found ${describe(t)}`, t.pos);
  }

  stringNode(t) {
    const parts = t.v.map((p) => {
      if (typeof p === "string") return p;
      const sub = new Parser(this.src, { map: this.map, tokens: lex(p.src, this.map, p.offset) });
      sub.enter(true);
      const e = sub.expression();
      const end = sub.peek();
      if (end.t !== "eof") throw new MotifError(`expected the end of \${…}, found ${describe(end)}`, end.pos);
      return e;
    });
    if (parts.length === 1 && typeof parts[0] === "string") return { k: "str", v: parts[0], pos: t.pos };
    return { k: "interp", parts, pos: t.pos };
  }

  listLiteral() {
    const open = this.next();
    this.enter(true);
    const saved = this.noRecord;
    this.noRecord = false;
    const items = [];
    while (!this.isOp("]")) {
      items.push(this.expression());
      if (items.length === 1 && this.version >= 2 && this.isKw("for")) {
        const comp = this.comprehension(open, items[0]);
        this.noRecord = saved;
        this.leave();
        return comp;
      }
      if (!this.eatOp(",")) break;
    }
    this.expectOp("]", "to close the list (or a \",\" between its items)");
    this.noRecord = saved;
    this.leave();
    return { k: "list", items, pos: open.pos };
  }

  /** [expr for x in xs if c for y in ys …]: after the first item, at its `for`. */
  comprehension(open, expr) {
    const clauses = [];
    while (this.isKw("for")) {
      const t = this.next();
      const a = this.pattern();
      let b = null;
      if (this.eatOp(",")) b = this.pattern();
      this.expectKw("in");
      clauses.push({ k: "for", key: b ? a : null, item: b ?? a, iter: this.expression(), pos: t.pos });
      while (this.isKw("if")) {
        const it = this.next();
        clauses.push({ k: "if", cond: this.expression(), pos: it.pos });
      }
    }
    const close = this.expectOp("]", "to close the list");
    return { k: "comp", expr, clauses, pos: open.pos, end: close.end };
  }

  recordLiteral() {
    const open = this.next();
    this.enter(true);
    const saved = this.noRecord;
    this.noRecord = false;
    const entries = [];
    const seen = new Set();
    while (!this.isOp("}")) {
      const kt = this.peek();
      let key;
      if (kt.t === "ident" || kt.t === "kw") key = kt.v;
      else if (kt.t === "str" && kt.v.length === 1 && typeof kt.v[0] === "string") key = kt.v[0];
      else throw new MotifError(`expected a field name, found ${describe(kt)}`, kt.pos);
      this.next();
      if (seen.has(key)) throw new MotifError(`field "${key}" is given twice`, kt.pos);
      seen.add(key);
      let value;
      if (this.eatOp(":")) value = this.expression();
      else if (kt.t === "ident") value = { k: "ident", name: key, pos: kt.pos, shorthand: true }; // { name } = { name: name }
      else throw new MotifError(`expected ":" after the field "${key}"`, this.peek().pos);
      entries.push({ key, value, pos: kt.pos });
      this.eatOp(","); // commas between fields are optional; line breaks will do
    }
    this.expectOp("}", "to close the record");
    this.noRecord = saved;
    this.leave();
    return { k: "rec", entries, pos: open.pos };
  }

  fnLiteral() {
    const t = this.next();
    const params = this.params();
    if (this.eatOp("=>")) {
      this.skipNl();
      return { k: "fnlit", params, body: this.fnBody(() => this.expression()), expr: true, pos: t.pos };
    }
    const saved = this.noRecord;
    this.noRecord = false;
    const body = this.fnBody(() => this.block());
    this.noRecord = saved;
    return { k: "fnlit", params, body, expr: false, pos: t.pos, end: this.toks[this.i - 1].end };
  }
}

/** Parse a whole TML source text. */
export function parse(src) {
  return new Parser(src).program();
}
