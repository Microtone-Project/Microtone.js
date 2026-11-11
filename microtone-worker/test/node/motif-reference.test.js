// The Motif language reference (assets/TAUD_MOTIF_LANGUAGE.md) documents
// every builtin, with its parameters in order under their real names — any
// argument can be given by name, so a name the document gets wrong is a
// program that fails. TML 2's builtins are the `#### name(…)` entries of
// §8–§10. (A `tml 1` program still builds, but the reference no longer
// documents that first version.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stdlib2 } from "../../src/motif/stdlib.js";
import { Score, musicBuiltins } from "../../src/motif/music.js";
import { Builtin } from "../../src/motif/values.js";

const DOC = readFileSync(new URL("../../assets/TAUD_MOTIF_LANGUAGE.md", import.meta.url), "utf8");

/** "name(a, b, rest…)" → { name, params: ["a", "b", "...rest"] } */
const parseSig = (sig) => {
  const m = /^([a-z_0-9]+)\((.*)\)$/i.exec(sig);
  if (!m) return null;
  const params = m[2].split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.endsWith("…") ? "..." + s.slice(0, -1) : s));
  return { name: m[1], params };
};
const codeSig = (f) => [...f.params.map((p) => p.name), ...(f.rest ? ["..." + f.rest] : [])];

/** Every signature written as `name(…)` in the given lines. */
const sigsIn = (lines) => {
  const out = [];
  for (const l of lines) for (const m of l.matchAll(/`([a-z_0-9]+\([^`]*\))`/gi)) { const s = parseSig(m[1]); if (s) out.push(s); }
  return out;
};
const section = (from, to) => DOC.slice(DOC.indexOf(from), DOC.indexOf(to)).split("\n");

const v2 = (() => {
  const base = stdlib2({ seed: () => 1, log: () => {} });
  return new Map([...base, ...musicBuiltins(new Score({ version: 2 }), { version: 2, base })]);
})();
// TML 2 keeps these names only to say what to write instead (§6)
const REFUSED_IN_V2 = new Set(["push", "pop", "insert", "remove", "seed"]);

test("every TML 2 builtin has a reference entry, its parameters named as the code names them", () => {
  const entries = sigsIn(section("## 8. Music", "## 11. Building").filter((l) => l.startsWith("#### ")));
  const byName = new Map();
  for (const s of entries) byName.set(s.name, [...(byName.get(s.name) ?? []), s.params]);
  for (const [name, f] of v2) {
    if (!(f instanceof Builtin) || REFUSED_IN_V2.has(name)) continue;
    assert.ok(byName.has(name), `${name}() has no #### entry in §8–§10`);
    for (const params of byName.get(name)) assert.deepEqual(params, codeSig(f), `${name}()'s entry names its parameters wrongly`);
  }
  for (const name of byName.keys()) assert.ok(v2.has(name), `the reference has an entry for ${name}(), which TML 2 does not have`);
  assert.match(DOC, /^#### `PI`$/m);
});

test("every entry's argument table lists the parameters of its signature, in order", () => {
  const lines = section("## 8. Music", "## 11. Building");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#### ")) continue;
    const sigs = sigsIn([lines[i]]);
    if (sigs.length !== 1) continue;           // grouped entries describe their arguments in prose
    const { name, params } = sigs[0];
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("#### ") && !lines[j].startsWith("| Argument |")) j++;
    if (!params.length) continue;
    assert.ok(lines[j]?.startsWith("| Argument |"), `${name}() has no argument table`);
    const rows = [];
    for (let k = j + 2; k < lines.length && lines[k].startsWith("|"); k++) rows.push(lines[k]);
    const listed = rows.map((r) => /^\| `([^`]+)`/.exec(r)?.[1]).map((s) => (s.endsWith("…") ? "..." + s.slice(0, -1) : s));
    assert.deepEqual(listed, params, `${name}()'s argument table`);
  }
});
