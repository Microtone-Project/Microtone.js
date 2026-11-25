#!/usr/bin/env node
// Compiles the third-party notices of Chromium as Qt WebEngine ships it, from
// the Qt documentation's own pages for them:
//
//   node desktop-qt/tools/qtwebengine-credits.js [--qt 6.11] [--out <file>]
//
// https://doc.qt.io/qt-<series>/qtwebengine-licensing.html lists every
// component of Chromium that Qt WebEngine's build carries, and each entry has
// a page of its own holding the component's homepage and its licence text with
// the copyright lines — Qt's attribution files, rendered. This fetches the
// list and every page and writes ONE text file, which the packages carry
// (desktop-qt/licences/, collect-notices.js). Run it again when Qt moves to
// another series (the CI's Qt is 6.11.x: `qmake -query QT_VERSION`) and
// commit the file; the output holds no dates, so a rerun that finds nothing
// new changes nothing.
//
// Node only, no dependencies (the repository's rule); Node 22's fetch.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const series = opt("--qt", "6.11");
const out = opt(
  "--out",
  fileURLToPath(new URL("../licences/qtwebengine-third-party.txt", import.meta.url)),
);
const base = `https://doc.qt.io/qt-${series}/`;

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescape = (s) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return name.toLowerCase() in entities ? entities[name.toLowerCase()] : m;
  });
// Qt's pages escape the licence text once more than the page needs: a quote
// in a licence reads `&amp;quot;` in the markup. Decoding twice gives the text.
const text = (s) => unescape(unescape(s));

async function get(url, tries = 4) {
  for (let n = 1; ; n++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.text();
    } catch (e) {
      if (n >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * n));
    }
  }
}

const list = await get(`${base}qtwebengine-licensing.html`);
const rows = [...list.matchAll(
  /<td class="tblName"[^>]*><p><a href="([^"]+)">(.*?)<\/a><\/p><\/td><td class="tblDescr"><p>(.*?)<\/p>/gs,
)].map((m) => ({ href: m[1], name: text(m[2]).replace(/\s+/g, " ").trim(), licence: text(m[3]).trim() }));
if (rows.length < 100) throw new Error(`only ${rows.length} components in the list: the page changed shape`);

// One page can answer several rows (a component with two entries).
const pages = new Map();
for (const row of rows) {
  if (!pages.has(row.href)) pages.set(row.href, { href: row.href, names: [], licences: [] });
  const p = pages.get(row.href);
  if (!p.names.includes(row.name)) p.names.push(row.name);
  for (const l of row.licence.split(/\s*,\s*/)) if (l && !p.licences.includes(l)) p.licences.push(l);
}

const fetched = new Map();
const queue = [...pages.keys()];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const href = queue.shift();
    fetched.set(href, await get(base + href));
  }
}));

function body(html, href) {
  const start = html.indexOf('<div class="descr" id="details">');
  const end = html.indexOf("<!-- @@@", start);
  if (start < 0 || end < 0) throw new Error(`${href}: no description block`);
  let s = html.slice(start, end);
  s = s.replace(/<a href="([^"]+)">Project Homepage<\/a>/g, (_, u) => `Homepage: ${text(u)}`);
  s = s.replace(/<\/p>|<\/div>/g, "\n").replace(/<[^>]+>/g, "");
  return text(s).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

const rule = "=".repeat(78);
const parts = [
  `Chromium, as Qt WebEngine ${series} ships it: third-party notices`,
  "",
  `Compiled from ${base}qtwebengine-licensing.html and the page of each component`,
  `it lists (${pages.size} entries), by desktop-qt/tools/qtwebengine-credits.js. The`,
  "text under each heading is the component's own licence as Qt publishes it.",
  "Any GPL named below is used only to reach Linux system resources: Qt",
  "WebEngine neither links to nor distributes GPL binary code (Qt's note).",
];
for (const p of pages.values()) {
  parts.push("", rule, p.names.join(" / "), `Licence: ${p.licences.join(", ")}`, rule, "", body(fetched.get(p.href), p.href));
}
writeFileSync(out, parts.join("\n") + "\n");
console.log(`${pages.size} components, ${(parts.join("\n").length / 1024).toFixed(0)} KB → ${out}`);
