// Motif (item 208): the editor's syntax highlighting. An overlay is only
// usable if it holds every character of the source, in order, whatever state
// the text is in mid-typing — and if it reads the code the way the parser does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { highlightTML } from "../../src/motif/highlight.js";
import { analyze } from "../../src/motif/analysis.js";
import { MOTIF_EXAMPLE } from "../../src/ui/motifexample.js";

const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** [class, text] for every highlighted span. */
const spans = (h) => [...h.matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)].map((m) => [m[1], plain(m[2])]);
const classOf = (h, text) => spans(h).find(([, s]) => s === text)?.[0] ?? null;

test("every character comes back, in order — finished programs and broken ones", () => {
  const demo = readFileSync(new URL("../../assets/demo_projects/Huygens_clock.tml", import.meta.url), "utf8");
  for (const src of [demo, MOTIF_EXAMPLE, 'let s = "never closed', 'let s = """\n  open', "'C4", "/* open",
    'x = "${a + "}"}" <tag> & 1 < 2', "$", "0x", "12ab", "a..<b", "\t\r\n"]) {
    assert.equal(plain(highlightTML(src)), src, JSON.stringify(src.slice(0, 40)));
  }
  // spans balance, so the overlay's markup is well formed
  for (const src of ['let s = "a${b}c${d("e")}f"', 'x = """\n  ${1}\n  """']) {
    const h = highlightTML(src);
    assert.equal((h.match(/<span/g) ?? []).length, (h.match(/<\/span>/g) ?? []).length, src);
  }
});

test("it reads the code the way the parser does", () => {
  const h = highlightTML(`tml 1
song { bars: 4 }
instrument KIT { bank: 128, program: 0 }
lane kick { inst: KIT, pan: $80 }
section "intro" 1..4
fn dr(lane, bar, row = 0) { hit(lane, at(bar, row), midi(36), 50) }
let s = "a\\n\${note_name('C4')}" // done
for r in 0..<14 by 2 { dr(kick, 1, r) }
let lane = 3
r.field = 1.5e-2
`);
  assert.equal(classOf(h, "tml"), "t-kw");
  assert.equal(classOf(h, "song"), "t-decl");
  assert.equal(classOf(h, "instrument"), "t-decl");
  assert.equal(classOf(h, "KIT"), "t-name");
  assert.equal(classOf(h, "section"), "t-decl");
  assert.equal(classOf(h, "bars"), "t-fld");
  assert.equal(classOf(h, "$80"), "t-num");
  assert.equal(classOf(h, "1.5e-2"), "t-num");
  assert.equal(classOf(h, "dr"), "t-fnd");
  assert.equal(classOf(h, "row"), "t-par");
  assert.equal(classOf(h, "hit"), "t-bi", "a builtin's call");
  assert.equal(classOf(h, "'C4'"), "t-pitch");
  assert.equal(classOf(h, "\\n"), "t-esc");
  assert.equal(classOf(h, "${"), "t-esc");
  assert.equal(classOf(h, "// done"), "t-com");
  assert.equal(classOf(h, "by"), "t-kw", "by after a range");
  assert.equal(classOf(h, "field"), "t-fld");
  assert.equal(classOf(h, "..<"), "t-op");
  // `lane` is a declaration only where one can start: as a name it is plain
  const calls = spans(highlightTML("dr(kick, 1, r)\nfoo(1)"));
  assert.deepEqual(calls.filter(([c]) => c === "t-fn").map(([, s]) => s), ["dr", "foo"], "a call of your own");
  assert.equal(classOf(highlightTML("let lane = 3"), "lane"), null);
});

test("with an analysis, a name is drawn by what it refers to", () => {
  const src = `tml 2
instrument KIT { bank: 128, program: 0 }
lane kick { inst: KIT, pan: $80 }
let total = 4
fn groove(bar, variant = 0) {
  let hv = [60, 0, 44]
  for r in 0..<3 if hv[r] != 0 and variant == 0 { hit(kick, at(bar, r), midi(36), hv[r]) }
  let f = fn(x) => x + total
  f(bar)
  log("\${bar}")
}
groove(bar: 1)
`;
  const at = (h, text, nth = 0) => spans(h).filter(([, s]) => s === text)[nth]?.[0] ?? null;
  const all = (h, text) => spans(h).filter(([, s]) => s === text).map(([c]) => c);
  const h = highlightTML(src, analyze(src));
  // a parameter is one wherever it is named, in a string's \${…} too
  assert.deepEqual(all(h, "bar"), ["t-par", "t-par", "t-par", "t-par", "t-fld"], "bar, and the named argument");
  assert.deepEqual(all(h, "variant"), ["t-par", "t-par"]);
  assert.deepEqual(all(h, "x"), ["t-par", "t-par"], "a lambda's");
  // a lane or an instrument, wherever it is named
  assert.deepEqual(all(h, "kick"), ["t-name", "t-name"]);
  assert.deepEqual(all(h, "KIT"), ["t-name", "t-name"]);
  // a local, underlined over whatever colour it has; the program's own lets are not local
  assert.deepEqual(all(h, "hv"), ["t-loc", "t-loc", "t-loc"]);
  assert.deepEqual(all(h, "r"), ["t-loc", "t-loc", "t-loc", "t-loc"]);
  assert.equal(at(h, "f", 1), "t-fn t-loc", "a local called");
  assert.deepEqual(all(h, "total"), [], "a global");
  // without one, only the declarations
  const bare = highlightTML(src);
  assert.deepEqual(all(bare, "bar"), ["t-par", "t-fld"]);
  assert.deepEqual(all(bare, "kick"), ["t-name"]);
  assert.deepEqual(all(bare, "hv"), []);
});

test("an edit keeps the names around it, moved with the text, until the next analysis", () => {
  const src = "tml 1\nlane kick { inst: 1 }\nfn g(bar) {\n  hit(kick, bar)\n  hit(kick, bar)\n}\n";
  const a = analyze(src);
  // half typed, and so not parsing: what the last analysis said still holds either side
  const typed = src.replace("  hit(kick, bar)\n  hit", "  hit(kick, ba\n  let y = (\n  hit");
  assert.equal(analyze(typed).ok, false);
  const h = highlightTML(typed, a);
  assert.equal(plain(h), typed);
  assert.deepEqual(spans(h).filter(([, s]) => s === "kick").map(([c]) => c), ["t-name", "t-name", "t-name"]);
  assert.deepEqual(spans(h).filter(([, s]) => s === "bar").map(([c]) => c), ["t-par", "t-par"]);
  assert.equal(classOf(h, "ba"), null, "a name being typed waits");
});
