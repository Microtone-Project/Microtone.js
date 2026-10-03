// Item 30: the documentation viewer's Markdown renderer (src/ui/markdown.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  renderMarkdown, extractToc, slug, firstSection, firstParagraph, sectionHeadlines,
  topLevelBullets,
} from "../../src/ui/markdown.js";

test("slug: stable, ascii-kebab, non-empty", () => {
  assert.equal(slug("0. Tracker terminologies"), "0-tracker-terminologies");
  assert.equal(slug("Effect **A** — Speed"), "effect-a-speed");
  assert.equal(slug("   "), "section");
});

test("headings carry slug ids", () => {
  const html = renderMarkdown("# Title\n\n## Section One\n\n### Sub");
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<h2 id="section-one">Section One<\/h2>/);
  assert.match(html, /<h3 id="sub">Sub<\/h3>/);
});

test("fenced code is escaped and verbatim", () => {
  const html = renderMarkdown("```js\nconst a = b < c && d > e;\n```");
  assert.match(html, /<pre><code>const a = b &lt; c &amp;&amp; d &gt; e;<\/code><\/pre>/);
  // no inline formatting inside code
  assert.ok(!html.includes("<strong>"));
});

test("inline: bold / italic / code / link, HTML-escaped", () => {
  const html = renderMarkdown("A **bold** and *italic* and `x<y` and [ref](https://e.com).");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<a href="https:\/\/e\.com" target="_blank" rel="noopener">ref<\/a>/);
});

test("links: in-page anchors same-tab, external new-tab", () => {
  const html = renderMarkdown("See [effects](#effects) and [repo](https://e.com).");
  assert.match(html, /<a href="#effects">effects<\/a>/);
  assert.match(html, /<a href="https:\/\/e\.com" target="_blank" rel="noopener">repo<\/a>/);
});

test("GFM table renders thead/tbody with cells", () => {
  const md = "| Cmd | Meaning |\n| --- | --- |\n| A | Speed |\n| T | Tempo |";
  const html = renderMarkdown(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Cmd<\/th><th>Meaning<\/th>/);
  assert.match(html, /<td>A<\/td><td>Speed<\/td>/);
  assert.match(html, /<td>T<\/td><td>Tempo<\/td>/);
});

test("lists: unordered + one level of nesting", () => {
  const md = "- one\n- two\n  - two-a\n- three";
  const html = renderMarkdown(md);
  assert.match(html, /<ul><li>one<\/li>/);
  assert.match(html, /<li>two<ul><li>two-a<\/li><\/ul><\/li>/);
  assert.match(html, /<li>three<\/li><\/ul>/);
});

test("ordered list", () => {
  const html = renderMarkdown("1. first\n2. second");
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("horizontal rule + paragraph", () => {
  const html = renderMarkdown("para one\n\n---\n\npara two");
  assert.match(html, /<p>para one<\/p>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<p>para two<\/p>/);
});

test("renders the real TAUD_NOTE_EFFECTS.md without throwing + builds a TOC", () => {
  const md = readFileSync(fileURLToPath(new URL("../../assets/TAUD_NOTE_EFFECTS.md", import.meta.url)), "utf8");
  const html = renderMarkdown(md);
  assert.ok(html.length > 10000);
  assert.match(html, /<h1 id="taud-tracker-effect-command-reference">/);
  const toc = extractToc(md);
  assert.ok(toc.length > 10, "TOC has many entries");
  assert.ok(toc.every((e) => e.slug && e.text && (e.level === 2 || e.level === 3)));
  // slugs are unique enough to anchor (allow a few dupes but not mostly)
  assert.ok(new Set(toc.map((e) => e.slug)).size > toc.length * 0.8);
});

test("renders the real USER_MANUAL.md without throwing + builds a TOC", () => {
  const md = readFileSync(fileURLToPath(new URL("../../assets/USER_MANUAL.md", import.meta.url)), "utf8");
  const html = renderMarkdown(md);
  assert.match(html, /<h1 id="[^"]+">Microtone User Manual<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code>/);
  const toc = extractToc(md);
  assert.ok(toc.length > 20, "TOC has many entries");
  assert.ok(toc.every((e) => e.slug && e.text && (e.level === 2 || e.level === 3)));
  assert.equal(new Set(toc.map((e) => e.slug)).size, toc.length, "manual slugs unique");
});

// Item 95: the patch notes are a plain assets/*.md served by the same viewer.
// The invariants worth pinning are the ones a future append can break: every
// section is a bare ISO date, and the newest one comes first.
test("PATCH_NOTES.md: dated sections, newest first, renders + TOCs", () => {
  const md = readFileSync(fileURLToPath(new URL("../../assets/PATCH_NOTES.md", import.meta.url)), "utf8");
  const html = renderMarkdown(md);
  assert.match(html, /<h1 id="patch-notes">Patch Notes<\/h1>/);
  const toc = extractToc(md);
  assert.ok(toc.length > 5, "one TOC entry per dated section");
  assert.ok(toc.every((e) => e.level === 2 && /^\d{4}-\d{2}-\d{2}$/.test(e.text)),
    "every section heading is a bare ISO date");
  assert.equal(new Set(toc.map((e) => e.slug)).size, toc.length, "dates are unique");
  const dates = toc.map((e) => e.text);
  assert.deepEqual(dates, [...dates].sort().reverse(), "newest section first");
});

// Item 104: the welcome screen's "what's new" panel excerpts the newest dated
// section of PATCH_NOTES.md through these two.
test("firstSection: newest section only, preamble and deeper headings skipped", () => {
  const md = "# Title\n\nBlurb.\n\n## 2026-08-05\n\n- one\n- two\n\n### Detail\n\n- three\n\n" +
             "## 2026-07-30\n\n- old\n";
  const sec = firstSection(md);
  assert.equal(sec.title, "2026-08-05");
  assert.equal(sec.body, "- one\n- two\n\n### Detail\n\n- three");
  assert.ok(!sec.body.includes("old"), "stops at the next section");
  assert.ok(!sec.body.includes("Blurb"), "the preamble is not part of it");
  assert.equal(firstSection("# Only an h1\n\ntext"), null);
  // a `##` inside a fence neither opens nor closes a section
  const fenced = "## A\n\n```\n## not a heading\n```\n\n## B\n";
  assert.equal(firstSection(fenced).body, "```\n## not a heading\n```");
});

test("topLevelBullets: markers stripped, nested items dropped", () => {
  const md = "- one\n  - nested\n- two\n\ntext\n\n1. three\n";
  assert.deepEqual(topLevelBullets(md), ["one", "two", "three"]);
  assert.deepEqual(topLevelBullets("```\n- in code\n```\n- real"), ["real"]);
});

test("firstParagraph: a section's headline, or nothing when it has none", () => {
  assert.equal(firstParagraph("A headline.\n\n- one\n- two\n"), "A headline.");
  // Soft-wrapped prose joins into one line; the list still ends it.
  assert.equal(firstParagraph("One line\nand its wrap.\n\n- one\n"), "One line and its wrap.");
  // A bullet straight after the heading means the section has no headline —
  // every patch-notes section written before 2026-09-03 looks like this.
  assert.equal(firstParagraph("- one\n- two\n"), "");
  assert.equal(firstParagraph("\n\n- one\n"), "", "leading blank lines are skipped");
  // Anything that opens a block other than a paragraph counts as "none".
  assert.equal(firstParagraph("### Detail\n\ntext\n"), "");
  assert.equal(firstParagraph("| a | b |\n"), "");
  assert.equal(firstParagraph("> quoted\n"), "");
  assert.equal(firstParagraph("```\ncode\n```\n"), "");
  // A list on the line right after the prose ends it without a blank line.
  assert.equal(firstParagraph("Headline.\n- one\n"), "Headline.");
});

test("sectionHeadlines: one per paragraph-then-list group, blank line required", () => {
  const md = "Lead one.\n\n- a\n- b\n\nLead two.\n\n- c\n";
  assert.deepEqual(sectionHeadlines(md), ["Lead one.", "Lead two."]);
  // a bare bullet list — most of the changelog's older sections — has none
  assert.deepEqual(sectionHeadlines("- a\n- b\n"), []);
  // prose with nothing but more prose after it has none either
  assert.deepEqual(sectionHeadlines("Just prose.\n\nMore prose.\n"), []);
  // a trailing paragraph with no list to follow it is not counted
  assert.deepEqual(sectionHeadlines("Lead.\n\n- a\n\nTrailing, no list.\n"), ["Lead."]);
  // unlike firstParagraph, a run-together "headline\n- item" (no blank line)
  // is NOT recognised here — nothing in the real patch notes writes it that
  // way, and the blank line is what tells a paragraph from a list intro.
  assert.deepEqual(sectionHeadlines("Headline.\n- one\n"), []);
  // a fence spanning a blank line doesn't get mistaken for a group boundary
  assert.deepEqual(sectionHeadlines("Lead.\n\n```\nblank\n\nline inside\n```\n\n- a\n"), []);
});

test("PATCH_NOTES.md: the newest section yields a renderable teaser", () => {
  const md = readFileSync(fileURLToPath(new URL("../../assets/PATCH_NOTES.md", import.meta.url)), "utf8");
  const sec = firstSection(md);
  assert.match(sec.title, /^\d{4}-\d{2}-\d{2}$/, "the teaser's heading is the date");
  const bullets = topLevelBullets(sec.body);
  assert.ok(bullets.length >= 3, "the newest batch has headline items to show");
  const html = renderMarkdown(bullets.slice(0, 5).map((b) => `- ${b}`).join("\n"));
  assert.match(html, /^<ul><li>/, "renders as one flat list");
  assert.ok(!html.includes("<h2"), "no heading leaks into the excerpt");
  // The welcome panel leads with the section's headline where there is one,
  // and renders it as a paragraph above that list.
  const lead = firstParagraph(sec.body);
  if (lead !== "") {
    const withLead = renderMarkdown([lead, "", ...bullets.slice(0, 4).map((b) => `- ${b}`)].join("\n"));
    assert.match(withLead, /^<p>/, "the headline renders as the first paragraph");
    assert.ok(withLead.includes("<ul><li>"), "and the bullets still follow it");
    assert.ok(!lead.startsWith("-"), "a headline is prose, not a bullet");
  }
  // sectionHeadlines' first entry is always that same paragraph — the section's
  // own opening group — whatever else the rest of the batch goes on to say.
  const heads = sectionHeadlines(sec.body);
  assert.equal(heads.length > 0 ? heads[0] : "", lead);
  assert.ok(heads.every((h) => h.length > 0 && !/^[-*+]\s/.test(h)), "a headline is prose, never a bullet");
  if (heads.length >= 2) {
    // Several unrelated changes in one batch: welcome.js shows the headlines
    // THEMSELVES here, not any one group's bullets — this is what it renders.
    const withHeads = renderMarkdown(heads.slice(0, 4).map((h) => `- ${h}`).join("\n"));
    assert.match(withHeads, /^<ul><li>/, "the headline list itself renders");
  }
});

// Item 997: the three Taud reference specifications. They are heavily
// cross-linked, so the invariant worth pinning (beyond "renders at all") is
// that every in-page anchor resolves to a heading this renderer actually emits
// — a renamed section otherwise silently produces a dead link.
// The sketch format (Microtone Touch's .mtsk) is held to the same, and its
// links INTO the file format must land on headings there.
const assetText = (file) => readFileSync(fileURLToPath(new URL(`../../assets/${file}`, import.meta.url)), "utf8");
const headingIds = (md) => {
  const ids = new Set();
  for (const line of md.split("\n")) {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) ids.add(slug(h[2]));
  }
  return ids;
};
for (const [file, h1, minToc] of [
  ["TAUD_ENGINE_SPEC.md", "Taud Engine Specification", 20],
  ["TAUD_FILE_FORMAT.md", "Taud File Format Specification", 20],
  ["TAUD_CONVERSION_NOTES.md", "Taud Conversion Notes", 20],
  ["MICROTONE_SKETCH_FORMAT.md", "Microtone Sketch File Format Specification", 15],
]) {
  test(`renders ${file} + TOC + every in-page anchor resolves`, () => {
    const md = assetText(file);
    const html = renderMarkdown(md);
    assert.ok(html.length > 10000);
    assert.match(html, new RegExp(`<h1 id="[^"]+">${h1}</h1>`));
    assert.match(html, /<table>/);

    const toc = extractToc(md);
    assert.ok(toc.length > minToc, "TOC has many entries");
    assert.ok(toc.every((e) => e.slug && e.text && (e.level === 2 || e.level === 3)));
    assert.equal(new Set(toc.map((e) => e.slug)).size, toc.length, "slugs unique");

    const ids = headingIds(md);
    const dead = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !ids.has(a));
    assert.deepEqual(dead, [], "no dead in-page anchors");
  });
}

test("the sketch format's links into the Taud File Format land on its headings", () => {
  const ids = headingIds(assetText("TAUD_FILE_FORMAT.md"));
  const links = [...assetText("MICROTONE_SKETCH_FORMAT.md").matchAll(/\]\(TAUD_FILE_FORMAT\.md#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 5);
  assert.deepEqual(links.filter((a) => !ids.has(a)), [], "no dead anchors into the file format");
});
