// Taud Motif Language (TML) — the lexer. Source text in, tokens out, each with
// the line and column it started on, so every error the parser or the
// interpreter raises can point at the text that caused it.
//
// Tokens: num, str (a list of literal and ${…} parts), pitch ('D5'), ident,
// kw (reserved words), op (punctuation), nl (one per run of line breaks) and
// eof. The language spec is assets/TAUD_MOTIF_LANGUAGE.md.

/** Every error Motif raises: a message plus where in the source it applies. */
export class MotifError extends Error {
  /**
   * @param message  what went wrong, in words a composer can act on
   * @param pos      {line, col} in the source, or null
   * @param trace    [{name, line, col}] — the TML call stack, innermost first
   */
  constructor(message, pos = null, trace = null) {
    super(message);
    this.name = "MotifError";
    this.pos = pos;
    this.trace = trace;
  }

  /** "12:5: message" — the form the CLI and the Motif view print. */
  get located() {
    return this.pos ? `${this.pos.line}:${this.pos.col}: ${this.message}` : this.message;
  }
}

/** Reserved everywhere. (song, lane, instrument, master, section and by are
 *  contextual: they are keywords only where a declaration can start.) */
export const KEYWORDS = new Set([
  "tml", "let", "fn", "for", "in", "while", "if", "then", "else", "return", "break",
  "continue", "and", "or", "not", "true", "false", "none",
]);

// Longest first, so "..<" wins over ".." and "**" over "*".
const OPERATORS = [
  "..<", "...", "**", "..", "==", "!=", "<=", ">=", "<<", ">>", "+=", "-=", "*=", "/=", "=>",
  "(", ")", "[", "]", "{", "}", ",", ":", ";", ".", "=", "<", ">", "+", "-", "*", "/", "%",
  "&", "|", "^", "~",
];

const MAX_SOURCE = 2 * 1024 * 1024;

/** Line/column lookup for byte offsets of one source text. */
export class SourceMap {
  constructor(src) {
    this.starts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  pos(offset) {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo] + 1, offset };
  }
}

const isDigit = (c) => c >= "0" && c <= "9";
const isHex = (c) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isIdStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdPart = (c) => isIdStart(c) || isDigit(c);

/**
 * Tokenise `src`. `base` offsets every position (an interpolation inside a
 * string is lexed on its own, at the offset it sits at in the file).
 */
export function lex(src, map = new SourceMap(src), base = 0) {
  if (src.length > MAX_SOURCE) throw new MotifError(`the source is ${src.length} characters long; the limit is ${MAX_SOURCE}`);
  const toks = [];
  let i = 0;
  const at = (o) => map.pos(base + o);
  const err = (msg, o = i) => new MotifError(msg, at(o));
  const push = (t, v, start) => toks.push({ t, v, pos: at(start), end: base + i });

  while (i < src.length) {
    const c = src[i];
    // line breaks: one nl token per run (blank lines and comments between
    // statements change nothing)
    if (c === "\n" || c === "\r") {
      const start = i;
      i++;
      if (toks.length && toks[toks.length - 1].t !== "nl") push("nl", null, start);
      continue;
    }
    if (c === " " || c === "\t" || c === "\f" || c === "\v" || c === "﻿") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i >= src.length) throw err("this comment is never closed (*/ missing)", start);
      i += 2;
      continue;
    }
    // numbers: 120, 0.8, 1e-3, $7300 (tracker hex), 0x7300, 0b1010
    if (isDigit(c) || (c === "$" && isHex(src[i + 1] ?? ""))) {
      const start = i;
      let v;
      if (c === "$" || (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X"))) {
        i += c === "$" ? 1 : 2;
        const s = i;
        while (i < src.length && isHex(src[i])) i++;
        if (i === s) throw err("a hexadecimal number needs digits", start);
        v = parseInt(src.slice(s, i), 16);
      } else if (c === "0" && (src[i + 1] === "b" || src[i + 1] === "B")) {
        i += 2;
        const s = i;
        while (i < src.length && (src[i] === "0" || src[i] === "1")) i++;
        if (i === s) throw err("a binary number needs digits", start);
        v = parseInt(src.slice(s, i), 2);
      } else {
        while (i < src.length && isDigit(src[i])) i++;
        // a fraction only when a digit follows the dot: 1..8 is a range
        if (src[i] === "." && isDigit(src[i + 1] ?? "")) {
          i++;
          while (i < src.length && isDigit(src[i])) i++;
        }
        if ((src[i] === "e" || src[i] === "E") &&
            (isDigit(src[i + 1] ?? "") || ((src[i + 1] === "+" || src[i + 1] === "-") && isDigit(src[i + 2] ?? "")))) {
          i += 2;
          while (i < src.length && isDigit(src[i])) i++;
        }
        v = Number(src.slice(start, i));
      }
      if (isIdPart(src[i] ?? "")) throw err(`"${src.slice(start, i + 1)}" is not a number`, start);
      push("num", v, start);
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < src.length && isIdPart(src[i])) i++;
      const word = src.slice(start, i);
      push(KEYWORDS.has(word) ? "kw" : "ident", word, start);
      continue;
    }
    if (c === "\"") {
      const start = i;
      const triple = src.startsWith("\"\"\"", i);
      const parts = triple ? lexTriple(src, map, base, () => i, (n) => { i = n; }, err) : lexString(src, map, base, () => i, (n) => { i = n; }, err);
      push("str", parts, start);
      continue;
    }
    if (c === "'") {
      const start = i;
      i++;
      const s = i;
      while (i < src.length && src[i] !== "'" && src[i] !== "\n") i++;
      if (src[i] !== "'") throw err("this pitch is never closed (' missing)", start);
      const v = src.slice(s, i).trim();
      i++;
      if (!v) throw err("an empty pitch ''", start);
      push("pitch", v, start);
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      const start = i;
      i += op.length;
      if (op === "...") throw err("\"...\" is not TML: a range is a..b (inclusive) or a..<b", start);
      push("op", op, start);
      continue;
    }
    if (c === "!") throw err("TML writes \"not\" for negation, and \"!=\" for not-equal");
    throw err(`unexpected character "${c}"`);
  }
  toks.push({ t: "eof", v: null, pos: at(i), end: base + i });
  return toks;
}

// ── strings ──
//
// A string's parts are literal text and {src, offset} interpolations, which
// the parser lexes and parses in place. Escapes: \n \t \r \0 \\ \" \' \$ \{
// \u{1F3B5} and \uXXXX.

function readEscape(src, j, err) {
  const e = src[j];
  switch (e) {
    case "n": return ["\n", j + 1];
    case "t": return ["\t", j + 1];
    case "r": return ["\r", j + 1];
    case "0": return ["\0", j + 1];
    case "\\": case "\"": case "'": case "$": case "{": case "}": return [e, j + 1];
    case "u": {
      if (src[j + 1] === "{") {
        const close = src.indexOf("}", j + 2);
        const hex = close < 0 ? "" : src.slice(j + 2, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) throw err("a \\u{…} escape needs 1–6 hex digits", j - 1);
        return [String.fromCodePoint(parseInt(hex, 16)), close + 1];
      }
      const hex = src.slice(j + 1, j + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw err("a \\u escape needs four hex digits (or \\u{…})", j - 1);
      return [String.fromCharCode(parseInt(hex, 16)), j + 5];
    }
    default: throw err(`unknown escape \\${e ?? ""}`, j - 1);
  }
}

/** The end of a ${…} interpolation: the matching brace, skipping nested
 *  strings and braces. */
function interpEnd(src, j, err, start) {
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === "\"") {
      j++;
      while (j < src.length && src[j] !== "\"") { if (src[j] === "\\") j++; if (src[j] === "\n") break; j++; }
      j++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { if (depth === 0) return j; depth--; }
    j++;
  }
  throw err("this ${…} is never closed", start);
}

function lexString(src, map, base, getI, setI, err) {
  let j = getI() + 1;
  const parts = [];
  let lit = "";
  for (;;) {
    if (j >= src.length || src[j] === "\n") throw err("this string is never closed (\" missing) — a string that runs over several lines is written \"\"\"…\"\"\"", getI());
    const c = src[j];
    if (c === "\"") { j++; break; }
    if (c === "\\") { const [s, n] = readEscape(src, j + 1, err); lit += s; j = n; continue; }
    if (c === "$" && src[j + 1] === "{") {
      if (lit) parts.push(lit);
      lit = "";
      const end = interpEnd(src, j + 2, err, j);
      parts.push({ src: src.slice(j + 2, end), offset: base + j + 2 });
      j = end + 1;
      continue;
    }
    lit += c;
    j++;
  }
  if (lit || parts.length === 0) parts.push(lit);
  setI(j);
  return parts;
}

/**
 * """…""": runs over lines. When the opening quotes end their line, that line
 * break is not part of the text; when the closing quotes start their own line,
 * the break before them is not either, and their indentation is removed from
 * every line (so the text can be indented with the code around it).
 */
function lexTriple(src, map, base, getI, setI, err) {
  const start = getI();
  const close = src.indexOf("\"\"\"", start + 3);
  if (close < 0) throw err("this string is never closed (\"\"\" missing)", start);
  let a = start + 3, b = close;
  // the opening line's break
  let k = a;
  while (k < b && (src[k] === " " || src[k] === "\t")) k++;
  if (src[k] === "\r") k++;
  if (src[k] === "\n") a = k + 1;
  // the closing quotes' indentation
  let indent = "";
  let ls = b;
  while (ls > a && (src[ls - 1] === " " || src[ls - 1] === "\t")) ls--;
  if (ls > a && src[ls - 1] === "\n") {
    indent = src.slice(ls, b);
    b = ls - 1;
    if (b > a && src[b - 1] === "\r") b--;
  } else if (ls === a && a > start + 3) {
    b = a; // nothing but the closing line
  }
  // Walk the body: literal text with ${…} parts, stripping `indent` at each
  // line start.
  const parts = [];
  let lit = "";
  let j = a;
  let lineStart = true;
  while (j < b) {
    if (lineStart && indent) {
      const line = src.slice(j, Math.min(b, j + indent.length));
      if (line === indent) j += indent.length;
      else {
        // a blank line may be shorter than the indentation
        let w = j;
        while (w < b && (src[w] === " " || src[w] === "\t")) w++;
        if (w < b && src[w] !== "\n" && src[w] !== "\r") throw err("this line is indented less than the closing \"\"\"", j);
        j = w;
      }
      lineStart = false;
      continue;
    }
    lineStart = false;
    const c = src[j];
    if (c === "\r") { j++; continue; }
    if (c === "\n") { lit += "\n"; j++; lineStart = true; continue; }
    if (c === "\\") { const [s, n] = readEscape(src, j + 1, err); lit += s; j = n; continue; }
    if (c === "$" && src[j + 1] === "{") {
      if (lit) parts.push(lit);
      lit = "";
      const end = interpEnd(src, j + 2, err, j);
      parts.push({ src: src.slice(j + 2, end), offset: base + j + 2 });
      j = end + 1;
      continue;
    }
    lit += c;
    j++;
  }
  if (lit || parts.length === 0) parts.push(lit);
  setI(close + 3);
  return parts;
}
