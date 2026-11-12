// The C engine's struct layouts for the WebAssembly target, as data: where
// every field of every record in core/engine/c/src/taud_internal.h sits in the
// module's memory. tools/make-engine-wasm.js writes it beside the module
// (core/engine/taud-engine.layout.js), and core/engine/wasm-reflect.js turns
// it into views that read and write the engine's state under its own field
// names — which are, by the port's rule, the JavaScript engine's names.
//
// The compiler is the source: `clang -Xclang -fdump-record-layouts-complete`
// prints each record with its field offsets for the target being compiled
// for. A typedef'd anonymous struct appears there only as "unnamed at
// file:line:col", so its name is read back from the header at that line.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** C scalar types → [kind, bytes]. Kinds are wasm-reflect.js's accessors. */
const SCALARS = {
  "_Bool": ["b", 1],
  "char": ["i8", 1], "signed char": ["i8", 1], "unsigned char": ["u8", 1],
  "int8_t": ["i8", 1], "uint8_t": ["u8", 1],
  "short": ["i16", 2], "unsigned short": ["u16", 2], "int16_t": ["i16", 2], "uint16_t": ["u16", 2],
  "int": ["i32", 4], "unsigned int": ["u32", 4], "unsigned": ["u32", 4],
  "long": ["i32", 4], "unsigned long": ["u32", 4],
  "int32_t": ["i32", 4], "uint32_t": ["u32", 4], "size_t": ["u32", 4], "uintptr_t": ["u32", 4],
  "long long": ["i64", 8], "unsigned long long": ["u64", 8], "int64_t": ["i64", 8], "uint64_t": ["u64", 8],
  "float": ["f32", 4], "double": ["f64", 8],
  // enums and function pointers of the public header
  "TaudError": ["i32", 4], "TaudWavQuality": ["i32", 4],
  "TaudRandomFn": ["u32", 4], "TaudInterruptFn": ["u32", 4],
};

/** The typedef name of the anonymous struct or union opened at `line` of
 *  `file`: the identifier after its closing brace. */
function typedefNameAt(sources, file, line) {
  const text = sources.get(file) ?? (sources.set(file, readFileSync(file, "utf8")), sources.get(file));
  const lines = text.split("\n");
  let depth = 0, seen = false;
  for (let i = line - 1; i < lines.length; i++) {
    const code = lines[i].replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
    for (let k = 0; k < code.length; k++) {
      const c = code[k];
      if (c === "{") { depth++; seen = true; }
      else if (c === "}") {
        depth--;
        if (seen && depth === 0) {
          const m = code.slice(k + 1).match(/^\s*([A-Za-z_]\w*)/);
          return m ? m[1] : null;
        }
      }
    }
  }
  return null;
}

/** Parse the dump into blocks: { key, size, align, lines: [{off, depth, type, name}] }. */
function parseDump(dump) {
  const blocks = [];
  let cur = null;
  for (const raw of dump.split("\n")) {
    if (raw.startsWith("*** Dumping AST Record Layout")) { cur = null; continue; }
    const size = raw.match(/^\s*\| \[sizeof=(\d+), align=(\d+)\]/);
    if (size) {
      if (cur) { cur.size = +size[1]; cur.align = +size[2]; blocks.push(cur); }
      cur = null;
      continue;
    }
    const m = raw.match(/^\s*(\d+)(:\d+-\d+)? \|( +)(.*)$/);
    if (!m) continue;
    if (m[2]) throw new Error(`a bit-field in the engine's structs: ${raw.trim()}`);
    const depth = (m[3].length - 1) / 2;
    const text = m[4];
    if (cur === null) {
      cur = { key: text, lines: [] };
      continue;
    }
    const sp = text.lastIndexOf(" ");
    cur.lines.push({ off: +m[1], depth, type: text.slice(0, sp), name: text.slice(sp + 1) });
  }
  return blocks;
}

/**
 * The layouts: { TypeName: { size, fields: { name: field } } } where a field
 * is [offset, kind] or [offset, kind, dims]: kind a scalar code ("b", "u8", …
 * "f64"), "p" (a pointer to a scalar or to nothing known), "p:Type" (a pointer
 * to a record) or "s:Type" (the record itself, inline); dims the array's
 * dimensions, outermost first. Only records the engine header defines.
 */
export function dumpEngineLayout({ clang, sysroot, cDir }) {
  const tmp = mkdtempSync(join(tmpdir(), "taud-layout-"));
  let dump;
  try {
    const probe = join(tmp, "probe.c");
    writeFileSync(probe, '#include "taud_internal.h"\n');
    dump = execFileSync(clang, [
      "--target=wasm32-wasip1", ...(sysroot ? [`--sysroot=${sysroot}`] : []), "-std=c99",
      `-I${join(cDir, "include")}`, `-I${join(cDir, "src")}`,
      "-Xclang", "-fdump-record-layouts-complete", "-fsyntax-only", probe,
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const sources = new Map();
  const blocks = parseDump(dump);
  // key (as the dump writes a type) → its name here
  const nameOf = new Map();
  const byName = new Map();
  for (const b of blocks) {
    const at = b.key.match(/^(?:struct|union) \(unnamed at (.+):(\d+):\d+\)$/);
    let name = null;
    if (at) {
      if (!at[1].startsWith(cDir)) continue; // a libc record
      name = typedefNameAt(sources, at[1], +at[2]);
    } else if (/^struct [A-Za-z_]\w*$/.test(b.key)) {
      name = b.key.slice(7);
      if (!name.startsWith("Taud")) continue; // timeval, iovec, …
    }
    if (name === null) continue; // a nested anonymous record: named below, by its field
    b.name = name;
    nameOf.set(b.key, name);
    nameOf.set(name, name);
    nameOf.set(`struct ${name}`, name);
    byName.set(name, b);
  }
  // A nested anonymous record is written differently where it is a field's
  // type ("struct (unnamed at f:l:c)") and where it is dumped ("struct
  // (unnamed struct)::(unnamed at f:l:c)"); its place in the source is the
  // one thing both say.
  const placeOf = (text) => text.match(/\(unnamed at ([^()]+:\d+:\d+)\)$/)?.[1] ?? null;
  const anonymous = new Map();
  for (const b of blocks) if (!b.name && placeOf(b.key) !== null) anonymous.set(placeOf(b.key), b);

  const out = {};
  const build = (block, name) => {
    if (out[name]) return;
    const fields = {};
    out[name] = { size: block.size, fields };
    for (const line of block.lines) {
      if (line.depth !== 1) continue; // an inline record's own fields come from its block
      let type = line.type.replace(/\b(const|volatile)\b/g, "").replace(/\s+/g, " ").trim();
      const dims = [];
      // "T[4][2]" and "T *[32]": the dimensions trail the type
      for (let m; (m = type.match(/\[(\d+)\]$/)); type = type.slice(0, m.index).trim()) dims.unshift(+m[1]);
      let kind;
      if (type.endsWith("*")) {
        const target = type.replace(/\s*\*+$/, "").trim();
        const single = /\*\s*\*$/.test(type) ? null : nameOf.get(target);
        kind = single ? `p:${single}` : "p";
      } else if (SCALARS[type]) {
        kind = SCALARS[type][0];
      } else if (nameOf.has(type)) {
        kind = `s:${nameOf.get(type)}`;
      } else if (anonymous.has(placeOf(type))) {
        const inner = `${name}.${line.name}`;
        build(anonymous.get(placeOf(type)), inner);
        kind = `s:${inner}`;
      } else {
        throw new Error(`${name}.${line.name}: no layout for the type "${line.type}"`);
      }
      fields[line.name] = dims.length ? [line.off, kind, dims] : [line.off, kind];
    }
  };
  for (const [name, block] of byName) build(block, name);
  return out;
}
