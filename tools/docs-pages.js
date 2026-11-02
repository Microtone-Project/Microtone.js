// docs-pages.js — the documentation as ready-made pages (item 281), for the
// website's build: `node tools/stage-site.js microtone-worker <out> --docs`
// calls stageDocs() on the staged site.
//
// In the repository the documentation is one page, docs.html, that fetches a
// Markdown file and renders it in the browser (src/ui/docs.js) — no build
// step, which is what a local server, the tests and the desktop app run. On
// the site that costs a visitor the Markdown, the renderer and the rendering
// before a word shows, and leaves a search engine an empty page. So the build
// renders each document once, here, with the same renderer, into a page of
// its own:
//
//   docs/<id>/index.html   one per document (src/ui/doclist.js DOCS), served
//                          at /docs/<id>/: docs.html's own markup and styles,
//                          the contents list and the text already in place,
//                          its own <title>, description and canonical address.
//                          docs.js still runs there, for the theme and the
//                          drawer only (it sees `data-doc` on #content).
//   docs.html              replaced by a page that sends the addresses the app
//   docs/index.html        and the world already use (`docs.html#motif`,
//                          `docs.html#format/9-project-data`) on to the page
//                          that now holds them; without script, to the manual.
//   sitemap.xml, robots.txt  so a search engine finds every document.
//
// A link from one document to another (`TAUD_FILE_FORMAT.md#tuning`,
// `docs.html#motif`, `#effects`) becomes a link to that page. Every address a
// page refers to is checked against the staged files: a page that would 404 a
// stylesheet, or a link to a heading that is not there, fails the build here
// rather than on the site.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMarkdown, extractToc } from "../microtone-worker/src/ui/markdown.js";
import {
  DOCS, DEFAULT_DOC, SITE, docTarget, docNavHtml, headingsHtml, escapeText,
} from "../microtone-worker/src/ui/doclist.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "microtone-worker");

/** A document page's address, relative to another document page. */
const pageHref = (id, slug) => `../${id}/${slug ? `#${slug}` : ""}`;
const canonical = (id) => `${SITE}/docs/${id}/`;

/** Replace the one occurrence of `find` in `text`, or fail: docs.html is the
 *  template, and an edit to it that moves what is filled in must be noticed. */
function fillOnce(text, find, replacement, what) {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`docs-pages: docs.html has ${n} copies of ${what}, expected one`);
  return text.replace(find, () => replacement);
}

/** Prefix every relative href/src of the template with `prefix` (the page
 *  sits deeper than docs.html did). Absolute, in-page and data: URLs stay. */
export function rebase(html, prefix) {
  return html.replace(/\b(href|src)="([^"]*)"/g, (all, attr, url) =>
    /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url) || url === "" ? all : `${attr}="${prefix}${url}"`);
}

/** The text a document page shows for document `doc` (its Markdown `md`):
 *  links to other documents go to their pages, links to its own headings
 *  stay in place. */
export function renderDocument(doc, md) {
  return renderMarkdown(md, {
    link(url) {
      const to = docTarget(url);
      if (!to) return null;
      return to.id === doc.id
        ? { href: to.slug ? `#${to.slug}` : "#", newTab: false }
        : { href: pageHref(to.id, to.slug), newTab: false };
    },
  });
}

/** docs/<id>/index.html for one document. `template` is docs.html. */
export function docPage(template, doc, md) {
  const title = `Microtone — ${doc.title}`;
  const head = [
    `<meta name="description" content="${escapeText(doc.description)}" />`,
    `<link rel="canonical" href="${canonical(doc.id)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Microtone" />`,
    `<meta property="og:title" content="${escapeText(title)}" />`,
    `<meta property="og:description" content="${escapeText(doc.description)}" />`,
    `<meta property="og:url" content="${canonical(doc.id)}" />`,
  ].join("\n  ");
  let page = rebase(template, "../../");
  page = fillOnce(page, "<title>Microtone Documentation</title>", `<title>${escapeText(title)}</title>`, "the <title>");
  page = page.replace(/\n\s*<meta name="description"[^>]*>/, "");
  page = fillOnce(page, "</head>", `  ${head}\n</head>`, "</head>");
  page = fillOnce(page, '<nav class="docs-toc" id="toc"></nav>',
    `<nav class="docs-toc" id="toc">${docNavHtml(doc.id, (id) => pageHref(id))}${headingsHtml(extractToc(md))}</nav>`,
    "the empty contents list");
  page = fillOnce(page, '<main class="docs-content" id="content"></main>',
    `<main class="docs-content" id="content" data-doc="${doc.id}">\n${renderDocument(doc, md)}\n</main>`,
    "the empty #content");
  return page;
}

/**
 * The page at docs.html and docs/index.html: it reads the hash the live
 * viewer understood — `#<id>`, `#<id>/<heading>`, or a heading of the manual —
 * and replaces itself with that page. Without script, the manual; and a list
 * of the documents for anyone who stays. Its addresses are from the site's
 * root: Cloudflare serves docs.html at /docs as well as /docs.html, beside
 * docs/index.html at /docs/, and a relative one would mean something else at
 * each.
 */
export function redirectPage() {
  const ids = JSON.stringify(DOCS.map((d) => d.id));
  const list = DOCS.map((d) => `<li><a href="/docs/${d.id}/">${escapeText(d.title)}</a></li>`).join("\n    ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Microtone Documentation</title>
  <meta name="robots" content="noindex, follow" />
  <link rel="canonical" href="${canonical(DEFAULT_DOC)}" />
  <script>
    // The documentation used to be this one page, a document picked by the
    // hash; each now has a page of its own (tools/docs-pages.js).
    (function () {
      var ids = ${ids};
      var h = decodeURIComponent(location.hash.replace(/^#/, ""));
      var cut = h.indexOf("/");
      var id = cut < 0 ? h : h.slice(0, cut);
      var heading = cut < 0 ? "" : h.slice(cut + 1);
      if (ids.indexOf(id) < 0) { id = ${JSON.stringify(DEFAULT_DOC)}; heading = h; }
      location.replace("/docs/" + id + "/" + location.search + (heading ? "#" + encodeURIComponent(heading) : ""));
    })();
  </script>
  <noscript><meta http-equiv="refresh" content="0; url=/docs/${DEFAULT_DOC}/" /></noscript>
</head>
<body>
  <p>Microtone's documentation:</p>
  <ul>
    ${list}
  </ul>
</body>
</html>
`;
}

/** The day git last changed `file` (YYYY-MM-DD), or null outside a checkout. */
function lastChanged(file) {
  try {
    const d = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%cs", "--", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch {
    return null;
  }
}

export function sitemap(entries) {
  const urls = entries.map(({ loc, lastmod }) =>
    `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/**
 * Every address `html` (a page at `pagePath`, relative to the site root)
 * refers to that should be a file of the staged site `out` or a heading of
 * a document page, checked. Returns the failures as strings.
 */
export function checkReferences(html, pagePath, out, headingsOf) {
  const bad = [];
  const base = new URL(pagePath, "https://site.invalid/");
  for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) continue; // another site
    const u = new URL(url.replace(/&amp;/g, "&"), base);
    let path = decodeURIComponent(u.pathname).replace(/^\//, "");
    if (path === "" || path.endsWith("/")) path += "index.html";
    if (!existsSync(join(out, path))) { bad.push(`${pagePath}: ${url} (no ${path})`); continue; }
    const slug = decodeURIComponent(u.hash.replace(/^#/, ""));
    const m = path.match(/^docs\/([^/]+)\/index\.html$/);
    if (slug && m && headingsOf.has(m[1]) && !headingsOf.get(m[1]).has(slug)) {
      bad.push(`${pagePath}: ${url} (no heading #${slug} in ${m[1]})`);
    }
  }
  return bad;
}

/**
 * Write the pages into the staged site `out` (already staged by stageSite,
 * so docs.html and assets/ are there). Returns the number of files written.
 */
export function stageDocs({ out }) {
  const outAbs = resolve(out);
  const template = readFileSync(join(APP, "docs.html"), "utf8");
  const pages = [];
  const headingsOf = new Map();
  for (const doc of DOCS) {
    const md = readFileSync(join(APP, "assets", doc.file), "utf8");
    const html = docPage(template, doc, md);
    headingsOf.set(doc.id, new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1])));
    pages.push([`docs/${doc.id}/index.html`, html]);
  }
  pages.push(["docs.html", redirectPage()], ["docs/index.html", redirectPage()]);

  const entries = [
    { loc: `${SITE}/`, lastmod: null },
    { loc: `${SITE}/about/`, lastmod: lastChanged("microtone-worker/about/index.html") },
    ...DOCS.map((d) => ({ loc: canonical(d.id), lastmod: lastChanged(`microtone-worker/assets/${d.file}`) })),
  ];
  const files = [
    ...pages,
    ["sitemap.xml", sitemap(entries)],
    ["robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`],
  ];
  for (const [rel, text] of files) {
    mkdirSync(dirname(join(outAbs, rel)), { recursive: true });
    writeFileSync(join(outAbs, rel), text);
  }

  const bad = pages.flatMap(([rel, html]) => checkReferences(html, rel, outAbs, headingsOf));
  if (bad.length) throw new Error(`docs-pages: ${bad.length} reference(s) lead nowhere:\n  ${bad.join("\n  ")}`);
  return files.length;
}
