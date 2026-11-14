#!/usr/bin/env node
// .taudnot → built-in notation preset code (core/tuning/pitchtables.js).
//
// A notation made in the Notation Maker and saved as a .taudnot carries the
// same degrees and sym tokens a built-in preset does (src/doc/notation.js
// reads it); this prints it as one `pitchTablePresets` entry in the file's
// own style, or writes it into the table in index order.
//
//   node tools/taudnot2preset.js FILE.taudnot [options]
//
//   --slot N     the definition to take when the file carries several
//                (default: print every one; --write needs exactly one)
//   --index N    the notation index; default 10 × n for an n-tone equal
//                division of the octave, else required
//   --name S     the preset's name (default: the definition's own)
//   --t M|m|d    the type badge (default: as the Notation Maker reads it)
//   --write      insert the entry into core/tuning/pitchtables.js, before
//                the first preset with a higher index
//   --replace    with --write, replace an existing preset of the same index
//
// It refuses a definition that fails validateDef or has a symbol the Taud
// charset reader could not turn back into a token: a built-in must spell
// every degree. Run from microtone-worker/.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTaudnot, validateDef, defToPreset } from "../src/doc/notation.js";
import { pitchTablePresets } from "../core/tuning/pitchtables.js";

const PRESETS_FILE = fileURLToPath(new URL("../core/tuning/pitchtables.js", import.meta.url));
const BACKSLASH = String.fromCharCode(92);

function usage(msg) {
  if (msg) console.error(`taudnot2preset: ${msg}`);
  console.error("usage: node tools/taudnot2preset.js FILE.taudnot [--slot N] [--index N] "
    + "[--name S] [--t M|m|d] [--write [--replace]]");
  process.exit(2);
}

function parseArgs(argv) {
  const o = { file: null, slot: null, index: null, name: null, t: null, write: false, replace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    const int = () => {
      const s = val(); const v = Number(s);
      if (!Number.isInteger(v) || v < 0) usage(`${a}: not a whole number: ${s}`);
      return v;
    };
    if (a === "--slot") o.slot = int();
    else if (a === "--index") o.index = int();
    else if (a === "--name") o.name = val();
    else if (a === "--t") { o.t = val(); if (!["M", "m", "d"].includes(o.t)) usage("--t is M, m or d"); }
    else if (a === "--write") o.write = true;
    else if (a === "--replace") o.replace = true;
    else if (a === "-h" || a === "--help") usage();
    else if (a.startsWith("--")) usage(`unknown option ${a}`);
    else if (o.file === null) o.file = a;
    else usage(`unexpected argument ${a}`);
  }
  if (o.file === null) usage("no .taudnot given");
  if (o.replace && !o.write) usage("--replace only goes with --write");
  return o;
}

/**
 * A JS string literal in pitchtables.js's style: double quotes; with `escape`,
 * non-ASCII as \u escapes (the symbols — Shi'er lü's are), else raw (names).
 */
function jsString(s, escape = true) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"' || ch === BACKSLASH) out += BACKSLASH + ch;
    else if ((c >= 0x20 && c < 0x7f) || (!escape && c > 0x9f)) out += ch;
    else {
      // UTF-16 units, so an astral character becomes its surrogate pair
      for (let k = 0; k < ch.length; k++) {
        out += BACKSLASH + "u" + ch.charCodeAt(k).toString(16).toUpperCase().padStart(4, "0");
      }
    }
  }
  return out + '"';
}

const hex = (v) => "0x" + v.toString(16);

/** n when the table is exactly the n-tone equal division of the octave the presets use. */
function equalOctaveSize(def) {
  const n = def.table.length;
  if (def.interval !== 0x1000) return null;
  return def.table.every((v, i) => v === Math.round((i * 0x1000) / n)) ? n : null;
}

function presetFor(def, opts, many) {
  const issues = validateDef(def);
  if (issues.length) throw new Error(`slot ${def.slot} "${def.name}": invalid (${issues.join(", ")})`);
  const unread = def.syms.flatMap((s, i) => (s === null ? [i] : []));
  if (unread.length) {
    throw new Error(`slot ${def.slot} "${def.name}": degrees ${unread.join(", ")} have symbols `
      + "the Taud charset reader does not know");
  }
  let index = opts.index;
  if (index === null) {
    const n = equalOctaveSize(def);
    if (n === null) throw new Error(`slot ${def.slot} "${def.name}": not an equal division of the octave — give --index`);
    index = n * 10;
  } else if (many) throw new Error("--index names one preset: pick it with --slot");
  const p = defToPreset(def);
  return {
    index,
    name: opts.name ?? p.name,
    table: p.table,
    interval: p.interval,
    base: p.base,
    t: opts.t ?? p.t,
    sym: p.sym,
    exact: p.exact,
    exactInterval: p.exactInterval,
  };
}

const fineHex = (v) => `${hex(Math.round(v * 16))} / 16`;

/** True when `exact` is just the equal division of the period that
 *  pitchtables.js `exactOffsets` assumes for a built-in, so it need not be written. */
function equalDivision(p) {
  const n = p.exact.length, period = p.exactInterval ?? p.interval;
  return p.exact.every((v, i) => v === Math.round((i * period * 16) / n) / 16);
}

/** One line of pitchTablePresets, keyed and ordered as the hand-written entries are. */
export function presetLine(p) {
  const fields = [`index: ${p.index}`, `name: ${jsString(p.name, false)}`];
  if (p.interval === 0) {
    fields.push("interval: 0");
    if (p.base) fields.push(`base: ${hex(p.base)}`);
    fields.push(`t: ${jsString(p.t)}`, `table: [${p.table.map(hex).join(", ")}]`);
  } else {
    fields.push(`table: [${p.table.map(hex).join(", ")}]`, `interval: ${hex(p.interval)}`);
    // A definition stated at 65536-TET keeps its fraction for finePreset():
    // the period when it has one, and the degrees unless they are its equal division.
    if (p.exactInterval !== undefined) fields.push(`exactInterval: ${fineHex(p.exactInterval)}`);
    if (p.exact && !equalDivision(p)) fields.push(`exact: [${p.exact.map(fineHex).join(", ")}]`);
    fields.push(`t: ${jsString(p.t)}`);
  }
  fields.push(`sym: [${p.sym.map((s) => jsString(s)).join(", ")}]`);
  return `  ${p.index}: { ${fields.join(", ")} },`;
}

/** Insert (or replace) the entry in pitchtables.js's source, keeping the keys ascending. */
export function insertPreset(src, p, replace) {
  const start = src.indexOf("export const pitchTablePresets = {");
  const end = src.indexOf("\n};", start);
  if (start < 0 || end < 0) throw new Error("pitchTablePresets not found in pitchtables.js");
  const head = src.slice(0, start), body = src.slice(start, end), tail = src.slice(end);
  const lines = body.split("\n");
  // An entry starts on a line "  <index>: {"; it may run over several lines
  // (ProTracker's does), up to the next entry or the end of the object.
  const starts = [];
  lines.forEach((l, i) => { const m = /^ {2}(\d+): \{/.exec(l); if (m) starts.push({ i, index: Number(m[1]) }); });
  const own = starts.findIndex((s) => s.index === p.index);
  if (own >= 0) {
    if (!replace) throw new Error(`preset ${p.index} already exists — pass --replace to overwrite it`);
    const from = starts[own].i, to = own + 1 < starts.length ? starts[own + 1].i : lines.length;
    lines.splice(from, to - from, presetLine(p));
  } else {
    const after = starts.find((s) => s.index > p.index);
    lines.splice(after ? after.i : lines.length, 0, presetLine(p));
  }
  return head + lines.join("\n") + tail;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const defs = parseTaudnot(new Uint8Array(readFileSync(opts.file)));
  if (defs === null) throw new Error(`${opts.file}: not a .taudnot (version 'a')`);
  if (defs.length === 0) throw new Error(`${opts.file}: no definitions`);
  const picked = opts.slot === null ? defs : defs.filter((d) => d.slot === opts.slot);
  if (picked.length === 0) throw new Error(`${opts.file}: no definition in slot ${opts.slot}`);
  if (opts.write && picked.length !== 1) {
    throw new Error(`${opts.file} carries ${picked.length} definitions (slots ${picked.map((d) => d.slot).join(", ")}) — pick one with --slot`);
  }
  const presets = picked.map((d) => presetFor(d, opts, picked.length > 1));
  if (!opts.write) {
    for (const p of presets) {
      if (p.index in pitchTablePresets) console.error(`note: preset ${p.index} ("${pitchTablePresets[p.index].name}") already exists`);
      console.log(presetLine(p));
    }
    return;
  }
  const [p] = presets;
  writeFileSync(PRESETS_FILE, insertPreset(readFileSync(PRESETS_FILE, "utf8"), p, opts.replace));
  console.error(`wrote preset ${p.index} "${p.name}" (${p.table.length} degrees) into core/tuning/pitchtables.js`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`taudnot2preset: ${e.message}`); process.exit(1); });
}
