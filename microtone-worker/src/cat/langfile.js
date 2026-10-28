// A language table's own text (src/ui/lang/<code>.js, Touch's src/lang/
// <code>.js): read it, and write it back with new values while keeping
// everything else — comments, section rules, blank lines, the order — as it
// was. The CAT never re-generates a file it was given; it edits the lines
// whose value changed, inserts the keys English gained, and drops the keys
// English lost.
//
// Every entry of these files is ONE line, `  "key": "value",` with an
// optional trailing `// comment`; the CAT's test reads all four shipped
// tables and asserts that this parser and `import()` agree on every value.
// A line that is not an entry, a comment or blank is kept verbatim.

const ENTRY = /^(\s*)"((?:[^"\\]|\\.)+)":\s*("(?:[^"\\]|\\.)*")(,?)(\s*\/\/.*)?$/;
const SECTION = /^\s*\/\/\s*──\s*(.*?)\s*─*\s*$/;
const COMMENT = /^\s*\/\/\s?(.*)$/;
const OPEN = /^\s*export\s+default\s*\{\s*$/;
const CLOSE = /^\s*\}\s*;?\s*$/;

/** The value of a double-quoted JS string literal (the escapes JS knows). */
export function decodeLiteral(lit) {
  if (lit.length < 2 || lit[0] !== '"' || lit[lit.length - 1] !== '"') throw new Error(`not a string literal: ${lit}`);
  const body = lit.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const d = body[++i];
    switch (d) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "0": out += "\0"; break;
      case "x": out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; break;
      case "u":
        if (body[i + 1] === "{") {
          const end = body.indexOf("}", i);
          out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16));
          i = end;
        } else {
          out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
          i += 4;
        }
        break;
      case "\n": break; // line continuation
      default: out += d; // \" \\ \' and the identity escapes
    }
  }
  return out;
}

// Characters a reader cannot see or tell apart in an editor are written as
// escapes, as the shipped tables already do with the no-break space.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00a0\u00ad\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff]/g;

/** A double-quoted literal for `value`: JSON's escapes, plus \uXXXX for the invisible. */
export function encodeLiteral(value) {
  return JSON.stringify(value).replace(INVISIBLE, (c) => {
    if (c === "\n" || c === "\t" || c === "\r" || c === "\b" || c === "\f") return c; // already escaped by JSON
    return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

/**
 * Parse a table's text.
 * @returns {{ lines: string[], entries: Map<string, {line:number, value:string,
 *   literal:string, indent:string, comment:string}>, order: string[],
 *   context: Map<string, {section:string, notes:string[]}>,
 *   open: number, close: number }}
 *
 * `context` is what a translator reads beside a key: the section it sits
 * under (`// ── topbar ──`), the comment block above its group of lines (a
 * comment heads the entries after it until a blank line), and its own
 * trailing comment.
 */
export function parseLangFile(text) {
  const lines = text.split("\n");
  const entries = new Map();
  const order = [];
  const context = new Map();
  let open = -1, close = -1;
  let section = "";
  let notes = [];
  let lastWasEntry = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open < 0) {
      if (OPEN.test(line)) open = i;
      continue;
    }
    if (close >= 0) continue;
    const m = ENTRY.exec(line);
    if (m) {
      const [, indent, key, literal, , trailing] = m;
      const comment = trailing ? trailing.replace(/^\s*\/\/\s?/, "") : "";
      entries.set(key, { line: i, value: decodeLiteral(literal), literal, indent, comment });
      order.push(key);
      context.set(key, { section, notes: comment ? [...notes, comment] : notes });
      lastWasEntry = true;
      continue;
    }
    if (!line.trim()) { notes = []; lastWasEntry = false; continue; }
    const s = SECTION.exec(line);
    if (s) { section = s[1]; notes = []; lastWasEntry = false; continue; }
    const c = COMMENT.exec(line);
    if (c) {
      if (lastWasEntry) notes = [];
      notes = [...notes, c[1]];
      lastWasEntry = false;
      continue;
    }
    if (CLOSE.test(line)) { close = i; continue; }
    lastWasEntry = false;
  }
  if (open < 0 || close < 0) throw new Error("not a language table: no `export default { … };`");
  return { lines, entries, order, context, open, close };
}

/** Just the values, as `import()` would give them. */
export function langValues(text) {
  const { entries } = parseLangFile(text);
  return Object.fromEntries([...entries].map(([k, e]) => [k, e.value]));
}

/**
 * Rewrite a table.
 *   text      the table as it stands (its own layout is kept)
 *   values    key → the value it should have; a key absent from `values`, or
 *             null there, is left out of the file (it falls back to English).
 *             "" is a value like any other (en.js's own `css.font` is one)
 *   order     English's key order: where a new key goes, and which keys exist
 *   drop      remove entries whose key English no longer has (default true)
 * Unchanged lines are kept byte for byte — the literal is not re-encoded.
 */
export function writeLangFile({ text, values, order, drop = true }) {
  const parsed = parseLangFile(text);
  const known = new Set(order);
  const has = (k) => values[k] !== undefined && values[k] !== null;
  const lines = parsed.lines.slice();
  const remove = new Set();
  const indent = [...parsed.entries.values()][0]?.indent ?? "  ";

  for (const [key, e] of parsed.entries) {
    if ((drop && !known.has(key)) || (known.has(key) && !has(key))) { remove.add(e.line); continue; }
    if (!known.has(key)) continue; // an obsolete key kept on request: untouched
    if (values[key] === e.value) continue;
    lines[e.line] = `${e.indent}"${key}": ${encodeLiteral(values[key])},${e.comment ? ` // ${e.comment}` : ""}`;
  }

  // New keys go after the nearest English predecessor the file already has
  // (or right after `export default {`), in English's order.
  const inserts = new Map(); // line index → lines to put after it
  let anchor = parsed.open;
  for (const key of order) {
    const e = parsed.entries.get(key);
    if (e) { if (!remove.has(e.line)) anchor = e.line; continue; }
    if (!has(key)) continue;
    if (!inserts.has(anchor)) inserts.set(anchor, []);
    inserts.get(anchor).push(`${indent}"${key}": ${encodeLiteral(values[key])},`);
  }

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!remove.has(i)) out.push(lines[i]);
    // A removed anchor still carries what was inserted after it.
    const add = inserts.get(i);
    if (add) out.push(...add);
  }
  // The last entry before `};` must keep a comma-free JS object valid either
  // way — trailing commas are legal, so nothing to fix up.
  return out.join("\n");
}

/**
 * A new table for a language no file exists for yet: English's section rules
 * and layout, the translated values, and a header naming where it came from.
 * Keys with no value are left out (they fall back to English).
 */
export function newLangFile({ code, name, englishText, values }) {
  const en = parseLangFile(englishText);
  const out = [
    `// ${name} — translated from en.js (the reference list) with the Microtone`,
    `// translation workbench (microtone.cc/translation). Keys missing here fall`,
    `// back to English automatically. Register "${code}" in LANGS (i18n.js) to offer it.`,
    "",
    "export default {",
  ];
  // A blank line or a section rule is written only once an entry follows it,
  // so a section with nothing translated leaves no trace.
  const first = out.length;
  let pendingBlank = false;
  let pendingSection = null;
  for (let i = en.open + 1; i < en.close; i++) {
    const line = en.lines[i];
    const m = ENTRY.exec(line);
    if (m) {
      const key = m[2];
      const v = values[key];
      if (v === undefined || v === null || v === "") continue;
      if (pendingBlank && out.length > first) out.push("");
      if (pendingSection !== null) out.push(pendingSection);
      pendingBlank = false;
      pendingSection = null;
      out.push(`${m[1]}"${key}": ${encodeLiteral(v)},`);
      continue;
    }
    if (!line.trim()) { pendingBlank = true; continue; }
    if (SECTION.test(line)) pendingSection = line;
    // English's explanatory comments describe English; they are not copied.
  }
  out.push("};", "");
  return out.join("\n");
}
