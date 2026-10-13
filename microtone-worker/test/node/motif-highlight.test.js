// Motif (item 208): the editor's syntax highlighting. An overlay is only
// usable if it holds every character of the source, in order, whatever state
// the text is in mid-typing — and if it reads the code the way the parser does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { highlightTML } from "../../src/motif/highlight.js";
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
