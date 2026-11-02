// The documentation as ready-made pages (item 281): tools/docs-pages.js, run
// by `tools/stage-site.js microtone-worker <out> --docs` for the website.
//
//   - a link from one document to another is recognised however it is written
//     (docs.html#id/slug, #id, FILE.md#slug) and sent to the same place by the
//     live viewer (by hash) and the pre-rendered pages (by page);
//   - a staged site has a page per document whose text is exactly what the
//     live viewer renders, with its own title, description and canonical
//     address, and every address on it resolves (stageDocs fails otherwise —
//     a link to a missing heading included);
//   - docs.html becomes a page that sends every old address on;
//   - the sitemap names every document.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderMarkdown, extractToc } from "../../src/ui/markdown.js";
import { DOCS, docTarget, docNavHtml, headingsHtml } from "../../src/ui/doclist.js";
import { stageSite } from "../../../tools/stage-site.js";
import { stageDocs, renderDocument, redirectPage, rebase } from "../../../tools/docs-pages.js";

const APP = new URL("../../", import.meta.url);

test("docTarget recognises every way a document links another", () => {
  const cases = [
    ["docs.html", { id: "manual", slug: null }],
    ["docs.html#motif", { id: "motif", slug: null }],
    ["docs.html#format/9-project-data", { id: "format", slug: "9-project-data" }],
    ["docs.html#saving-and-autosave", { id: "manual", slug: "saving-and-autosave" }],
    ["#effects", { id: "effects", slug: null }],
    ["#patchnotes/version-4-6-0-2026-11-02", { id: "patchnotes", slug: "version-4-6-0-2026-11-02" }],
    ["TAUD_FILE_FORMAT.md", { id: "format", slug: null }],
    ["TAUD_FILE_FORMAT.md#tuning", { id: "format", slug: "tuning" }],
    ["assets/TAUD_ENGINE_SPEC.md#14-interrupts", { id: "engine", slug: "14-interrupts" }],
    ["#saving-and-autosave", null], // a heading of the document it is in
    ["README.md", null],
    ["https://microtone.cc/docs.html#motif", null],
  ];
  for (const [url, want] of cases) assert.deepEqual(docTarget(url), want, url);
});

test("renderMarkdown's link option places links; without it nothing changes", () => {
  const md = "[a](#here) [b](https://example.com/?x=1&y=2) [c](TAUD_FILE_FORMAT.md#tuning)";
  const plain = renderMarkdown(md);
  assert.match(plain, /<a href="#here">a<\/a>/);
  // the URL is escaped once (it used to be escaped twice: &amp;amp;)
  assert.match(plain, /<a href="https:\/\/example\.com\/\?x=1&amp;y=2" target="_blank" rel="noopener">b<\/a>/);
  assert.match(plain, /<a href="TAUD_FILE_FORMAT\.md#tuning" target="_blank" rel="noopener">c<\/a>/);

  const page = renderDocument(DOCS.find((d) => d.id === "manual"), md);
  assert.match(page, /<a href="#here">a<\/a>/);
  assert.match(page, /<a href="https:\/\/example\.com\/\?x=1&amp;y=2" target="_blank" rel="noopener">b<\/a>/);
  assert.match(page, /<a href="\.\.\/format\/#tuning">c<\/a>/, "another document's page, same tab");
  const own = renderDocument(DOCS.find((d) => d.id === "format"), md);
  assert.match(own, /<a href="#tuning">c<\/a>/, "a link to its own document stays on the page");
});

test("rebase prefixes only relative addresses", () => {
  const html = `<link href="css/a.css"><script src="src/x.js"></script><a href="#t"></a><a href="https://x.y/"></a><a href="/abs"></a><a href="mailto:a@b"></a>`;
  assert.equal(rebase(html, "../../"),
    `<link href="../../css/a.css"><script src="../../src/x.js"></script><a href="#t"></a><a href="https://x.y/"></a><a href="/abs"></a><a href="mailto:a@b"></a>`);
});

test("a staged site carries every document as a page of its own", (t) => {
  const out = mkdtempSync(join(tmpdir(), "docs-pages-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  stageSite({ site: "microtone-worker", out });
  stageDocs({ out }); // throws on any address that leads nowhere

  const template = readFileSync(new URL("docs.html", APP), "utf8");
  for (const doc of DOCS) {
    const md = readFileSync(new URL(`assets/${doc.file}`, APP), "utf8");
    const page = readFileSync(join(out, "docs", doc.id, "index.html"), "utf8");
    assert.ok(page.includes(`<title>Microtone — ${doc.title}</title>`), `${doc.id}: title`);
    assert.ok(page.includes(`<link rel="canonical" href="https://microtone.cc/docs/${doc.id}/" />`), `${doc.id}: canonical`);
    assert.equal(page.match(/<meta name="description"/g).length, 1, `${doc.id}: one description, its own`);
    assert.ok(page.includes(`<main class="docs-content" id="content" data-doc="${doc.id}">\n${renderDocument(doc, md)}\n</main>`),
      `${doc.id}: the text is the renderer's`);
    assert.ok(page.includes(docNavHtml(doc.id, (id) => `../${id}/`) + headingsHtml(extractToc(md))), `${doc.id}: contents`);
    assert.ok(page.includes('aria-current="page">' + doc.title.replace("&", "&amp;")), `${doc.id}: marked current`);
    // docs.html's own styles and script, reached from two levels down
    assert.ok(page.includes('<script type="module" src="../../src/ui/docs.js"></script>'), `${doc.id}: docs.js`);
    assert.ok(page.includes(template.match(/<style>[\s\S]*?<\/style>/)[0]), `${doc.id}: docs.html's styles`);
  }

  // the old single page sends its addresses on
  const redirect = readFileSync(join(out, "docs.html"), "utf8");
  assert.equal(redirect, redirectPage());
  assert.equal(readFileSync(join(out, "docs", "index.html"), "utf8"), redirectPage());
  const script = redirect.match(/<script>([\s\S]*?)<\/script>/)[1];
  const go = (hash, search = "") => {
    let to = null;
    new Function("location", script)({ hash, search, replace: (u) => { to = u; } });
    return to;
  };
  assert.equal(go(""), "/docs/manual/");
  assert.equal(go("#patchnotes"), "/docs/patchnotes/");
  assert.equal(go("#motif"), "/docs/motif/");
  assert.equal(go("#format/9-project-data"), "/docs/format/#9-project-data");
  assert.equal(go("#saving-and-autosave"), "/docs/manual/#saving-and-autosave");
  assert.equal(go("#effects", "?theme=warmth"), "/docs/effects/?theme=warmth");

  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
  for (const doc of DOCS) assert.ok(sitemap.includes(`<loc>https://microtone.cc/docs/${doc.id}/</loc>`), `sitemap: ${doc.id}`);
  assert.match(readFileSync(join(out, "robots.txt"), "utf8"), /^Sitemap: https:\/\/microtone\.cc\/sitemap\.xml$/m);
});

test("the live viewer and the site build list the same documents", () => {
  const viewer = readFileSync(new URL("src/ui/docs.js", APP), "utf8");
  assert.match(viewer, /from "\.\/doclist\.js"/);
  assert.doesNotMatch(viewer, /USER_MANUAL\.md|PATCH_NOTES\.md/, "the list lives in doclist.js only");
  const wrangler = readFileSync(new URL("../wrangler.toml", APP), "utf8");
  assert.match(wrangler, /^command = "node tools\/stage-site\.js microtone-worker build\/microtone-worker[^"]* --docs[^"]*"$/m,
    "the tracker's deploy writes the pages");
});
