// Syntax highlighting for TML, as HTML. Unlike the lexer it never throws: a
// half-typed program — an open string, a lone quote — still highlights, and
// every character of the source comes back exactly once, so an overlay of the
// result lines up with the text under it.
//
// Classes (the editor's stylesheet colours them from the theme's code tokens,
// which follow the Syntello / Dimtello schemes):
//   t-kw keyword · t-decl declaration word · t-num number · t-str string ·
//   t-esc escape and ${ } · t-pitch 'D5' · t-com comment · t-fn call ·
//   t-bi call of a builtin · t-fnd function being declared · t-par parameter ·
//   t-fld field or named argument · t-name declared lane/instrument · t-op operator ·
//   t-loc local variable (alongside any of the others)
//
// Given an analysis of the program (analysis.js), a name is drawn by what it
// refers to rather than only where it stands: every use of a parameter is a
// parameter, every use of a lane or an instrument a t-name, and a variable a
// block, a loop or a function declares is local wherever it is named.

import { KEYWORDS } from "./lexer.js";
import { stdlib, stdlib2 } from "./stdlib.js";
import { Score, musicBuiltins } from "./music.js";

const base2 = stdlib2({ seed: () => 1, log: () => {} });
/** Every builtin's name, in either version: a call of one is drawn apart from
 *  a call of your own. */
export const BUILTIN_NAMES = new Set([
  ...stdlib({ random: () => 0, reseed: () => {}, log: () => {} }).keys(),
  ...musicBuiltins(new Score()).keys(),
  ...base2.keys(),
  ...musicBuiltins(new Score({ version: 2 }), { version: 2, base: base2 }).keys(),
]);

const OPS = [
  "..<", "**", "..", "==", "!=", "<=", ">=", "<<", ">>", "+=", "-=", "*=", "/=", "=>",
  "(", ")", "[", "]", "{", "}", ",", ":", ";", ".", "=", "<", ">", "+", "-", "*", "/", "%",
  "&", "|", "^", "~",
];
const PUNCT = new Set(["(", ")", "[", "]", "{", "}", ",", ";", "."]);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls, s) => (cls ? `<span class="${cls}">${esc(s)}</span>` : esc(s));

const isDigit = (c) => c >= "0" && c <= "9";
const isHex = (c) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isIdStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdPart = (c) => isIdStart(c) || isDigit(c);

/** Source → [{k, s}]: k is ws, com, str (with parts), pitch, num, id, op. */
function scan(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const start = i;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r")) i++;
      toks.push({ k: "ws", s: src.slice(start, i) });
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      toks.push({ k: "com", s: src.slice(start, i) });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      toks.push({ k: "com", s: src.slice(start, i) });
      continue;
    }
    if (c === "\"") {
      const triple = src.startsWith("\"\"\"", i);
      i = triple ? stringEnd(src, i + 3, true) : stringEnd(src, i + 1, false);
      toks.push({ k: "str", s: src.slice(start, i), triple });
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'" && src[i] !== "\n") i++;
      if (src[i] === "'") i++;
      toks.push({ k: "pitch", s: src.slice(start, i) });
      continue;
    }
    if (isDigit(c) || (c === "$" && isHex(src[i + 1] ?? ""))) {
      if (c === "$" || (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X"))) {
        i += c === "$" ? 1 : 2;
        while (i < n && isHex(src[i])) i++;
      } else if (c === "0" && (src[i + 1] === "b" || src[i + 1] === "B")) {
        i += 2;
        while (i < n && (src[i] === "0" || src[i] === "1")) i++;
      } else {
        while (i < n && isDigit(src[i])) i++;
        if (src[i] === "." && isDigit(src[i + 1] ?? "")) { i++; while (i < n && isDigit(src[i])) i++; }
        if ((src[i] === "e" || src[i] === "E") &&
            (isDigit(src[i + 1] ?? "") || ((src[i + 1] === "+" || src[i + 1] === "-") && isDigit(src[i + 2] ?? "")))) {
          i += 2;
          while (i < n && isDigit(src[i])) i++;
        }
      }
      while (i < n && isIdPart(src[i])) i++; // "12ab" is one (bad) token, as the lexer sees it
      toks.push({ k: "num", s: src.slice(start, i) });
      continue;
    }
    if (isIdStart(c)) {
      while (i < n && isIdPart(src[i])) i++;
      toks.push({ k: "id", s: src.slice(start, i) });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    i += op ? op.length : 1;
    toks.push({ k: "op", s: src.slice(start, i) });
  }
  return toks;
}

/** Where a string that starts at `i` (after its quotes) ends: after its closing
 *  quotes, or at the end of its line (one-line) or of the file (triple). */
function stringEnd(src, i, triple) {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (triple ? src.startsWith("\"\"\"", i) : c === "\"") return i + (triple ? 3 : 1);
    if (!triple && c === "\n") return i;
    if (c === "\\") { i += 2; continue; }
    if (c === "$" && src[i + 1] === "{") { i = interpEnd(src, i + 2); continue; }
    i++;
  }
  return n;
}

/** The index just past the `}` that closes a ${…} opened before `i`. */
function interpEnd(src, i) {
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\"") { i = stringEnd(src, i + 1, false); continue; }
    if (c === "\n") return i;
    if (c === "{") depth++;
    else if (c === "}") { if (depth === 0) return i + 1; depth--; }
    i++;
  }
  return n;
}

/** A string token's HTML: its text, escapes and ${…} parts. The token starts
 *  at offset `at` of the text `names` are placed in. */
function stringHtml(s, triple, names, at) {
  const q = triple ? 3 : 1;
  let out = `<span class="t-str">${esc(s.slice(0, q))}`;
  let lit = "";
  const flush = () => { out += esc(lit); lit = ""; };
  let i = q;
  const n = s.length;
  const closes = s.length >= 2 * q && (triple ? s.endsWith("\"\"\"") : s.endsWith("\""));
  const end = closes ? n - q : n;
  while (i < end) {
    const c = s[i];
    if (c === "\\") {
      flush();
      let j = i + 2;
      if (s[i + 1] === "u") {
        if (s[i + 2] === "{") { const k = s.indexOf("}", i + 3); j = k < 0 ? end : k + 1; }
        else j = Math.min(end, i + 6);
      }
      out += span("t-esc", s.slice(i, Math.min(j, end)));
      i = j;
      continue;
    }
    if (c === "$" && s[i + 1] === "{") {
      flush();
      const j = Math.min(interpEnd(s, i + 2), end);
      const inner = s.slice(i + 2, s[j - 1] === "}" ? j - 1 : j);
      out += `${span("t-esc", "${")}</span>${highlight(inner, names, at + i + 2)}<span class="t-str">${s[j - 1] === "}" ? span("t-esc", "}") : ""}`;
      i = j;
      continue;
    }
    lit += c;
    i++;
  }
  flush();
  if (closes) out += esc(s.slice(n - q));
  return out + "</span>";
}

/** The class a name is drawn with for what it refers to, or null. */
function symClass(sym) {
  if (sym.kind === "parameter") return "t-par";
  if (sym.kind === "lane" || sym.kind === "instrument") return "t-name";
  // the program's own lets are global; any other scope's are local
  if ((sym.kind === "variable" || sym.kind === "loop") && sym.scope?.parent) return "t-loc";
  return null;
}

/**
 * The names analysis `a` (analysis.js) resolved, in `src`: offset → {name,
 * cls}. When `src` has been edited since the text `a` is of, the names before
 * and after the edit keep theirs, moved with the text; those within it wait
 * for the next analysis.
 */
function resolvedNames(a, src) {
  const out = new Map();
  if (!a?.ok) return out;
  const old = a.source;
  const max = Math.min(old.length, src.length);
  let p = 0;
  while (p < max && old.charCodeAt(p) === src.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && old.charCodeAt(old.length - 1 - q) === src.charCodeAt(src.length - 1 - q)) q++;
  const tail = old.length - q, shift = src.length - old.length;
  for (const o of a.occ) {
    if (o.named) continue; // a named argument stays a field
    const cls = symClass(o.sym);
    if (!cls) continue;
    // (a name the edit touches, `ba` typed on to `bar`, is told apart by its text)
    if (o.end <= p) out.set(o.start, { name: o.sym.name, cls });
    else if (o.start >= tail) out.set(o.start + shift, { name: o.sym.name, cls });
  }
  return out;
}

const DECL_BLOCK = new Set(["song", "master"]);
const DECL_NAMED = new Set(["instrument", "lane"]);

/**
 * TML source → highlighted HTML (every character, in order). `analysis`, from
 * analysis.js, of this text or of one it has since been edited from, colours
 * the names by what they refer to.
 */
export function highlightTML(src, analysis = null) {
  return highlight(src, resolvedNames(analysis, src), 0);
}

/** `src`, which starts at offset `base` of the text `names` are placed in. */
function highlight(src, names, base) {
  const toks = scan(src);
  let at = base;
  for (const t of toks) { t.at = at; at += t.s.length; }
  // the significant tokens' indices, for looking ahead and behind past spaces
  const sig = [];
  toks.forEach((t, i) => { if (t.k !== "ws" && t.k !== "com") sig.push(i); });
  const tok = (si) => (si >= 0 && si < sig.length ? toks[sig[si]] : null);
  const cls = new Array(toks.length).fill(null);
  // parameter lists: a (…) right after `fn` or a function's name
  let paramDepth = 0;
  let expectParams = false;
  let lineHasRange = false;
  for (let si = 0; si < sig.length; si++) {
    const ti = sig[si];
    const t = toks[ti];
    const prev = tok(si - 1), next = tok(si + 1), next2 = tok(si + 2);
    if (t.k === "op") {
      if (t.s === ".." || t.s === "..<") lineHasRange = true;
      if (t.s === "(" && expectParams) { paramDepth = 1; expectParams = false; }
      else if (paramDepth > 0) {
        if (t.s === "(" || t.s === "[" || t.s === "{") paramDepth++;
        else if (t.s === ")" || t.s === "]" || t.s === "}") paramDepth--;
      }
      if (!PUNCT.has(t.s)) cls[ti] = "t-op";
      continue;
    }
    if (t.k === "num") { cls[ti] = "t-num"; continue; }
    if (t.k === "pitch") { cls[ti] = "t-pitch"; continue; }
    if (t.k !== "id") continue;
    const w = t.s;
    // a statement starts after a line break, `;`, `{` or `}` (or the file's start)
    const startsStatement = !prev || prev.s === ";" || prev.s === "{" || prev.s === "}" ||
      /\n/.test(toks.slice(sig[si - 1] + 1, ti).map((x) => x.s).join(""));
    if (startsStatement) lineHasRange = false;
    if (KEYWORDS.has(w)) {
      cls[ti] = "t-kw";
      if (w === "fn") expectParams = true;
      continue;
    }
    if (startsStatement && DECL_BLOCK.has(w) && next?.s === "{") { cls[ti] = "t-decl"; continue; }
    if (startsStatement && DECL_NAMED.has(w) && next?.k === "id" && next2?.s === "{") {
      cls[ti] = "t-decl";
      cls[sig[si + 1]] = "t-name";
      si++;
      continue;
    }
    if (startsStatement && w === "section" && next?.k === "str") { cls[ti] = "t-decl"; continue; }
    if (w === "by" && lineHasRange) { cls[ti] = "t-kw"; continue; }
    if (prev?.s === "fn" && prev.k === "id") { cls[ti] = "t-fnd"; expectParams = true; continue; }
    if (paramDepth === 1 && (next?.s === "," || next?.s === ")" || next?.s === "=")) { cls[ti] = "t-par"; continue; }
    if (next?.s === "(") { cls[ti] = BUILTIN_NAMES.has(w) ? "t-bi" : "t-fn"; continue; }
    if (next?.s === ":") { cls[ti] = "t-fld"; continue; }
    if (prev?.s === ".") { cls[ti] = "t-fld"; continue; }
  }
  // what the analysis says each name is
  if (names.size) {
    toks.forEach((t, i) => {
      const r = t.k === "id" ? names.get(t.at) : null;
      if (!r || r.name !== t.s) return;
      cls[i] = r.cls === "t-loc" ? (cls[i] ? `${cls[i]} t-loc` : "t-loc") : r.cls;
    });
  }
  let out = "";
  toks.forEach((t, i) => {
    if (t.k === "ws") out += esc(t.s);
    else if (t.k === "com") out += span("t-com", t.s);
    else if (t.k === "str") out += stringHtml(t.s, t.triple, names, t.at);
    else out += span(cls[i], t.s);
  });
  return out;
}
